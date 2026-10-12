import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * The live model catalog takes prices from the gateway's `/v1/models`. A row
 * listed `billing_mode: "free"` used to join the catalog's free set, and
 * "free" switches off the strict maxCostPerRun cap (admission AND the signing
 * check). The listing and the 402 quote come from different code paths and
 * have disagreed before, so a model the listing calls free but whose 402 asks
 * for money must still be held to the cap.
 */

const MODEL = "openai/gpt-5.4-mini";
const QUOTE = "8000"; // $0.008 per call, from the 402
const CAP_USD = 0.012; // room for one call, not two

let upstream: Server;
let proxy: ProxyHandle;
let paidHits = 0;
let catalogServed: () => void;
const catalogReady = new Promise<void>((resolve) => (catalogServed = resolve));

beforeAll(async () => {
  upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: MODEL,
              name: "GPT-5.4 Mini",
              categories: ["chat"],
              billing_mode: "free", // the listing says free...
              pricing: { input: 0, output: 0 },
              context_window: 400000,
              max_output: 128000,
            },
          ],
        }),
      );
      setTimeout(catalogServed, 50);
      return;
    }
    for await (const _ of req) void _;
    if (req.headers["payment-signature"] || req.headers["x-payment"]) {
      paidHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion",
          model: MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
      return;
    }
    // ...but the 402 asks for money.
    const challenge = {
      x402Version: 2,
      resource: { url: "http://gw/v1/chat/completions" },
      accepts: [
        {
          scheme: "exact",
          network: CAIP2_BASE,
          amount: QUOTE,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1aA67D6375b98C476C427C7aca397045F52e25E1",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    res.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    res.end("{}");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  proxy = await startProxy({
    wallet: generatePrivateKey(),
    apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunUsd: CAP_USD,
    maxCostPerRunMode: "strict",
  });
  await catalogReady;
}, 20_000);

afterAll(async () => {
  await proxy?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

let seq = 0;
const send = (session: string) =>
  fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: `listed free ${seq++}` }],
    }),
  });

describe("a model the gateway lists as free is still held to the strict cap", () => {
  it("pays the quoted price once, then refuses the call that would cross the cap", async () => {
    const session = `listed-free-${Date.now()}`;
    const first = await send(session);
    await first.text();
    const second = await send(session);
    await second.text();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(paidHits).toBe(1); // was 2: "free" skipped the cap entirely
  });
});
