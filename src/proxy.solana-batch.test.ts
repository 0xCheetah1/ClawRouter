/**
 * Solana batch-settlement end to end through startProxy.
 *
 * The REAL @blockrun/llm SolanaBatchPayer and @x402/svm batch scheme build the
 * deposit, the per-call authorization and verify the operator's voucher. Only
 * the network is fake: a local gateway (402s, served calls with vouchers) and a
 * local Solana JSON-RPC (mint, blockhash, slot). The operator key is the test's
 * own, trusted through `solanaBatch.operators`, so the gateway can sign
 * vouchers like BlockRun's does.
 *
 * Pins that:
 *  - chat calls are paid in batch, never with an exact transfer;
 *  - the strict session cap counts what each call was CHARGED, not its ceiling
 *    (otherwise batch users would hit their cap 4x early);
 *  - a batch payment whose outcome is unknown is never paid again: no exact
 *    fallback, no retry.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { signBatchVoucher } from "@x402/svm/batch-settlement/client";

import { startProxy, type ProxyHandle } from "./proxy.js";
import type { BalanceMonitor } from "./balance.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";
import { deriveAllKeys } from "./wallet.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RECEIVER = "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA";
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const RECEIVER_AUTHORIZER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MODEL = "openai/gpt-5.4-nano";
const CEILING = 5000n; // the per-call quote, micro-USDC
const CHARGED = 1200n; // what each call actually costs
const CAP_USD = 0.008;

function rpcResult(method: string, params: unknown[]): unknown {
  const context = { slot: 400_000_000 };
  switch (method) {
    case "getBlockHeight":
      return 400_000_000;
    case "getEpochInfo":
      return {
        absoluteSlot: 400_001_000,
        blockHeight: 400_000_000,
        epoch: 900,
        slotIndex: 0,
        slotsInEpoch: 432_000,
      };
    case "isBlockhashValid":
      return { context, value: true };
    case "getAccountInfo": {
      if (params[0] !== USDC) return { context, value: null };
      const data = new Uint8Array(82);
      data[44] = 6; // decimals
      data[45] = 1; // is_initialized
      return {
        context,
        value: {
          data: [Buffer.from(data).toString("base64"), "base64"],
          executable: false,
          lamports: 1_461_600,
          owner: TOKEN_PROGRAM,
          rentEpoch: 0,
          space: 82,
        },
      };
    }
    case "getLatestBlockhash":
      return {
        context,
        value: {
          blockhash: "9T1tBhLxWWKf1XhD9deySUK2tNcmGQhBsR2tMKFLgFUL",
          lastValidBlockHeight: 430_673_687,
        },
      };
    case "getSlot":
      return 400_000_000;
    case "getProgramAccounts":
      return [];
    default:
      return null;
  }
}

function challengeHeader(operator: string): string {
  const accepts = [
    {
      scheme: "exact",
      network: NETWORK,
      amount: CEILING.toString(),
      asset: USDC,
      payTo: RECEIVER,
      maxTimeoutSeconds: 300,
      extra: { feePayer: FEE_PAYER },
    },
    {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: CEILING.toString(),
      asset: USDC,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: FEE_PAYER,
        withdrawDelay: 86_400,
        tokenProgram: TOKEN_PROGRAM,
        receiverAuthorizer: RECEIVER_AUTHORIZER,
        voucherSigner: "server",
        operator,
      },
    },
  ];
  const body = { x402Version: 2, resource: { url: "http://gw/v1/chat/completions" }, accepts };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

let operator: KeyPairSigner;
let rpc: Server;
let gateway: Server;
let proxy: ProxyHandle;
/** What the gateway does with a paid batch call. */
let batchMode: "serve" | "lose" | "no-receipt" | "hang" = "serve";
const payments: Array<{ model: string; amount: string; network: string }> = [];
let schemesPaid: string[] = [];
/** Cumulative charged per channel, as the gateway tracks it. */
const cumulative = new Map<string, bigint>();
const savedRpcEnv = process.env.CLAWROUTER_SOLANA_RPC_URL;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

beforeAll(async () => {
  operator = await generateKeyPairSigner();

  rpc = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { id, method, params } = JSON.parse(await readBody(req)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: rpcResult(method, params ?? []) }));
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  process.env.CLAWROUTER_SOLANA_RPC_URL = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;

  gateway = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await readBody(req);
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      res.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": challengeHeader(operator.address),
      });
      res.end(JSON.stringify({ error: "payment required" }));
      return;
    }
    const payment = JSON.parse(Buffer.from(header, "base64").toString()) as {
      accepted: { scheme: string };
      payload: { authorization?: { channelId: string } };
    };
    schemesPaid.push(payment.accepted.scheme);
    if (payment.accepted.scheme !== "batch-settlement") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "exact" } }] }));
      return;
    }
    if (batchMode === "lose") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream lost" }));
      return;
    }
    if (batchMode === "hang") return; // the paid request never gets an answer
    if (batchMode === "no-receipt") {
      // Served, but whatever was charged is not stated anywhere.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "batch" } }] }));
      return;
    }
    const channelId = payment.payload.authorization!.channelId;
    const total = (cumulative.get(channelId) ?? 0n) + CHARGED;
    cumulative.set(channelId, total);
    const voucher = await signBatchVoucher(operator, {
      channelId,
      maxClaimableAmount: total,
      expiresAt: 0,
    });
    const receipt = {
      success: true,
      transaction: "",
      network: NETWORK,
      amount: "",
      extra: {
        voucher,
        chargedAmount: CHARGED.toString(),
        commitmentId: `commit-${total}`,
        channelState: { channelId, chargedCumulativeAmount: total.toString() },
      },
    };
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64"),
    });
    res.end(
      JSON.stringify({
        id: "chatcmpl-batch",
        object: "chat.completion",
        model: MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: "batch" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));

  const keys = deriveAllKeys(MNEMONIC);
  proxy = await startProxy({
    wallet: { key: keys.evmPrivateKey, solanaPrivateKeyBytes: keys.solanaPrivateKeyBytes },
    paymentChain: "solana",
    apiBase: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunUsd: CAP_USD,
    maxCostPerRunMode: "strict",
    solanaBatch: { operators: [operator.address], channelStore: false },
    onPayment: (info) => void payments.push(info),
  });
}, 30_000);

afterAll(async () => {
  await proxy?.close();
  for (const s of [gateway, rpc]) {
    s?.closeAllConnections?.();
    await new Promise<void>((r) => s?.close(() => r()));
  }
  if (savedRpcEnv === undefined) delete process.env.CLAWROUTER_SOLANA_RPC_URL;
  else process.env.CLAWROUTER_SOLANA_RPC_URL = savedRpcEnv;
});

beforeEach(() => {
  batchMode = "serve";
  schemesPaid = [];
  payments.length = 0;
});

let seq = 0;
function chat(session: string | undefined, model = MODEL): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-session-id": session } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: `batch probe ${seq++}` }],
    }),
  });
}

describe("Solana batch-settlement through the proxy", () => {
  it("pays chat calls in batch and counts what they were charged against the strict cap", async () => {
    const session = `batch-${Date.now()}`;
    // Cap $0.008, ceiling $0.005, charge $0.0012. Booked at the charge:
    // 0 → 1200 → 2400 → 3600 all leave room for another $0.005 ceiling; the
    // fourth needs 3600 + 5000 > 8000 and is refused. Booked at the ceiling
    // (the bug this guards), the second call would already be refused.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await chat(session);
      await res.text();
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(schemesPaid).toEqual(["batch-settlement", "batch-settlement", "batch-settlement"]);
    // onPayment hears each confirmed batch charge, at what was charged.
    expect(payments.map((p) => p.amount)).toEqual(["1200", "1200", "1200"]);
    expect(payments.every((p) => p.network.startsWith("solana:") && p.model.length > 0)).toBe(true);
  }, 30_000);

  it("never pays a batch payment in doubt again: no exact fallback, no retry", async () => {
    batchMode = "lose";
    const res = await chat(`lost-${Date.now()}`);
    const text = await res.text();

    expect(res.status).not.toBe(200);
    expect(text).toMatch(/payment_in_doubt|unresolved/i);
    // One batch payment reached the gateway, and nothing after it.
    expect(schemesPaid).toEqual(["batch-settlement"]);
  }, 30_000);
  it("does not walk the routed fallback chain after a batch payment in doubt", async () => {
    // A routed request has other models to try. Moving on to the next one
    // would sign a new payment for the same request. No session, so the
    // strict cap is not in play and cannot mask a second payment.
    batchMode = "lose";
    const res = await chat(undefined, "blockrun/auto");
    const text = await res.text();

    expect(res.status).not.toBe(200);
    // The caller is told the payment is in doubt, not handed a later model's error.
    expect(text).toMatch(/payment_in_doubt/);
    expect(schemesPaid).toEqual(["batch-settlement"]);
  }, 30_000);
  it("keeps counting the ceiling when a paid batch call comes back without a receipt", async () => {
    // Cap $0.008, ceiling $0.005. With no receipt the charge is unknown, so the
    // first call keeps its $0.005 and the second (another $0.005) is refused.
    batchMode = "no-receipt";
    const session = `no-receipt-${Date.now()}`;
    const first = await chat(session);
    await first.text();
    const second = await chat(session);
    await second.text();

    expect([first.status, second.status]).toEqual([200, 429]);
    expect(schemesPaid).toEqual(["batch-settlement"]);
  }, 30_000);
  it("pays a chat call from the channel even when the liquid wallet balance looks too low", async () => {
    // After a deposit the wallet's liquid USDC can be near zero while the
    // channel holds plenty. The balance preflight must not downgrade the call
    // to a free model on liquid USDC alone.
    const broke = {
      getCachedBalance: () => undefined,
      checkBalance: async () => ({
        balance: 10n,
        balanceUSD: "$0.00",
        isLow: true,
        isEmpty: false,
        walletAddress: "x",
      }),
      checkSufficient: async () => ({
        sufficient: false,
        info: {
          balance: 10n,
          balanceUSD: "$0.00",
          isLow: true,
          isEmpty: false,
          walletAddress: "x",
        },
        shortfall: "$0.01",
      }),
      deductEstimated: () => {},
      invalidate: () => {},
    } as unknown as BalanceMonitor;
    // Its own wallet: the in-doubt tests above leave this file's main wallet
    // with a pending channel request, which (correctly) keeps it on exact.
    const keys = deriveAllKeys(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    const lowBalanceProxy = await startProxy({
      wallet: { key: keys.evmPrivateKey, solanaPrivateKeyBytes: keys.solanaPrivateKeyBytes },
      paymentChain: "solana",
      apiBase: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      port: 0,
      spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      solanaBatch: { operators: [operator.address], channelStore: false },
      _balanceMonitorOverride: broke,
    });
    try {
      const res = await fetch(`${lowBalanceProxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: `low balance ${seq++}` }],
        }),
      });
      const json = (await res.json()) as { model?: string };
      expect(res.status).toBe(200);
      expect(json.model).toBe(MODEL);
      expect(schemesPaid).toEqual(["batch-settlement"]);
    } finally {
      await lowBalanceProxy.close();
    }
  }, 30_000);
  it("reports a batch payment still in flight at the global deadline as in doubt, and never pays it again", async () => {
    batchMode = "hang";
    const keys = deriveAllKeys(
      "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    );
    const deadlineProxy = await startProxy({
      wallet: { key: keys.evmPrivateKey, solanaPrivateKeyBytes: keys.solanaPrivateKeyBytes },
      paymentChain: "solana",
      apiBase: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      port: 0,
      skipBalanceCheck: true,
      spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      requestTimeoutMs: 1_500,
      solanaBatch: { operators: [operator.address], channelStore: false, inDoubtMaxWaitMs: 300 },
    });
    const send = () =>
      fetch(`${deadlineProxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: "deadline probe" }],
        }),
      });
    try {
      const first = await send();
      const firstText = await first.text();
      expect(firstText).toMatch(/payment_in_doubt/);

      // The identical request again: answered from the in-doubt result, not paid.
      const second = await send();
      await second.text();
      expect(schemesPaid.filter((s) => s === "batch-settlement")).toHaveLength(1);
      expect(schemesPaid).not.toContain("exact");
    } finally {
      await deadlineProxy.close();
    }
  }, 30_000);
});
