import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { estimateAmount, startProxy, type ProxyHandle } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * EmberTail report ET-CLAWROUTER-20261010: two ways past the strict
 * `maxCostPerRun` cap on 0.12.282, reproduced with real settlements on a local
 * chain and on Base Sepolia. Same numbers here — a $0.012 cap, every request
 * quoted 8000 micro-USDC by the gateway:
 *
 *   - three concurrent requests all passed admission (nothing was reserved for
 *     requests in flight) and settled $0.024;
 *   - a payment that settled but came back as a 502 was never recorded, and the
 *     explicit-pin retry signed a second authorization: $0.016.
 *
 * Every paid request that reaches this gateway counts as a settlement — that is
 * the worst case the proxy has to assume, since "settled, response lost" and
 * "never arrived" look the same from its side.
 */

const CAP_USD = 0.012;
const QUOTE_MICROS = "8000";
const MODEL = "anthropic/claude-sonnet-4.6";
const MAX_TOKENS = 500;

type PaidMode = "ok" | "502" | "decline";

let upstream: Server;
let proxy: ProxyHandle;
let paidMode: PaidMode = "ok";
let paidDelayMs = 0;
let paidHits = 0;

function challengeHeader(): string {
  const challenge = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/v1/chat/completions" },
    accepts: [
      {
        scheme: "exact",
        network: CAIP2_BASE,
        amount: QUOTE_MICROS,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1aA67D6375b98C476C427C7aca397045F52e25E1",
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
}

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const paid = req.headers["payment-signature"] || req.headers["x-payment"];
      if (!paid) {
        res.writeHead(402, {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": challengeHeader(),
        });
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }
      paidHits++;
      const respond = () => {
        if (paidMode === "502") {
          // Settled, then the response is lost.
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad gateway" } }));
          return;
        }
        if (paidMode === "decline") {
          // A 402 answer to the paid request: payment declined, nothing settled.
          paidHits--;
          res.writeHead(402, {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": challengeHeader(),
          });
          res.end(JSON.stringify({ error: "payment verification failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: MODEL,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
        );
      };
      if (paidDelayMs > 0) setTimeout(respond, paidDelayMs);
      else respond();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as AddressInfo).port;

  proxy = await startProxy({
    wallet: generatePrivateKey(),
    apiBase: `http://127.0.0.1:${port}`,
    port: 0,
    skipBalanceCheck: true,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunUsd: CAP_USD,
    maxCostPerRunMode: "strict",
  });
}, 20_000);

afterAll(async () => {
  await proxy?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  paidMode = "ok";
  paidDelayMs = 0;
  paidHits = 0;
});

let seq = 0;
function send(session: string, maxTokens = MAX_TOKENS): Promise<Response> {
  // Distinct prompts, so the proxy's dedup cannot collapse concurrent requests.
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream: false,
      messages: [{ role: "user", content: `cap probe ${seq++}` }],
    }),
  });
}

describe("strict maxCostPerRun holds under concurrency and paid failures", () => {
  it("fixture: one request fits the cap, two do not", () => {
    // The numbers the cases below depend on, so a pricing change fails loudly
    // here instead of silently weakening them.
    const est = Number(estimateAmount(MODEL, 200, MAX_TOKENS)) / 1_000_000;
    expect(est).toBeLessThanOrEqual(CAP_USD);
    expect(est * 2).toBeGreaterThan(CAP_USD);
    expect((Number(QUOTE_MICROS) * 2) / 1_000_000).toBeGreaterThan(CAP_USD);
  });

  it("control: a single request settles once", async () => {
    const res = await send(`single-${Date.now()}`);
    expect(res.status).toBe(200);
    expect(paidHits).toBe(1);
  });

  it("control: serial requests stop at the cap", async () => {
    const session = `serial-${Date.now()}`;
    expect((await send(session)).status).toBe(200);
    expect((await send(session)).status).toBe(429);
    expect(paidHits).toBe(1);
  });

  it("three concurrent requests settle once, not three times", async () => {
    paidDelayMs = 300; // keep every request in flight at once
    const session = `concurrent-${Date.now()}`;
    const responses = await Promise.all([send(session), send(session), send(session)]);
    const statuses = responses.map((r) => r.status).sort();

    expect(paidHits).toBe(1); // was 3: $0.024 against a $0.012 cap
    expect(statuses).toEqual([200, 429, 429]);
    const refused = responses.find((r) => r.status === 429)!;
    expect(refused.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
  });

  it("concurrent requests quoted above their estimate still settle once", async () => {
    // A small request estimated well under the quote: both pass admission
    // (2 × est fits the cap), so only the signing check stands between them
    // and 2 × 8000 against 12000. Local EVM signing is too fast for the two
    // check→record windows to overlap here; the overlap itself (real on Solana,
    // where signing awaits an RPC read) is pinned by "reserves the quote as it
    // checks" in session-spend.test.ts. This pins the end-to-end outcome.
    const smallEst = Number(estimateAmount(MODEL, 200, 20)) / 1_000_000;
    expect(smallEst * 2).toBeLessThan(CAP_USD);
    paidDelayMs = 300;
    const session = `under-estimated-${Date.now()}`;
    const responses = await Promise.all([send(session, 20), send(session, 20)]);
    await Promise.all(responses.map((r) => r.text()));

    expect(paidHits).toBe(1);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    const refused = responses.find((r) => r.status === 429)!;
    expect(refused.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
  });

  it("a paid request that comes back 502 is not paid for again", async () => {
    paidMode = "502";
    const session = `lost-502-${Date.now()}`;
    const res = await send(session);
    await res.text();

    expect(res.status).not.toBe(200);
    expect(paidHits).toBe(1); // was 2: the retry signed a fresh authorization

    // And the lost payment counts: the session has spent $0.008 of $0.012.
    paidMode = "ok";
    const next = await send(session);
    expect(next.status).toBe(429);
    expect(paidHits).toBe(1);
  });

  it("a payment the gateway declined (402) does not count against the cap", async () => {
    paidMode = "decline";
    const session = `declined-${Date.now()}`;
    const res = await send(session);
    await res.text();
    expect(res.status).not.toBe(200);
    expect(paidHits).toBe(0);

    // Nothing settled, so the session still has its whole budget.
    paidMode = "ok";
    const next = await send(session);
    expect(next.status).toBe(200);
    expect(paidHits).toBe(1);
  });

  it("separate sessions do not share a budget", async () => {
    paidDelayMs = 200;
    const stamp = Date.now();
    const responses = await Promise.all([send(`a-${stamp}`), send(`b-${stamp}`)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(paidHits).toBe(2);
  });

  it("a finished request returns its hold", async () => {
    // The admission hold is released when the request ends; only real spend
    // stays. A hold that leaked would refuse this session's second request
    // even with a cap that has room for two.
    const session = `release-${Date.now()}`;
    paidMode = "decline";
    await (await send(session)).text();
    await (await send(session)).text();
    paidMode = "ok";
    expect((await send(session)).status).toBe(200);
  });
});
