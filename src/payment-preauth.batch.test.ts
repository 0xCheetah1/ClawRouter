/**
 * Routing of Solana batch-settlement inside the pay-fetch layer.
 *
 * The payer itself (@blockrun/llm's SolanaBatchPayer) is tested where it
 * lives. This pins what ClawRouter does with each outcome of `pay()`:
 *  - paid: the paid response is returned, no exact payment is ever signed;
 *  - fallback: nothing was charged, so exact pays, against the freshest
 *    challenge the batch attempt saw;
 *  - served / failed: returned as is, no payment;
 *  - a throw (payment in doubt): rethrown, and exact never pays it again;
 *  - and that only non-streaming chat completions go to the payer at all.
 */
import { describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAllKeys } from "./wallet.js";
import {
  createPayFetchWithPreAuth,
  type BatchOutcome,
  type BatchPayerLike,
  type SolanaBatchRoute,
} from "./payment-preauth.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const CHAT = "https://gw/api/v1/chat/completions";

function exactClient(): x402Client {
  const keys = deriveAllKeys(MNEMONIC);
  const account = privateKeyToAccount(keys.evmPrivateKey);
  const client = new x402Client().setSpendControls(false);
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(account, createPublicClient({ chain: base, transport: http() })),
  });
  return client;
}

function challenge(amount: string) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    resource: { url: CHAT, description: "chat", mimeType: "application/json" },
  };
}

function quote(amount = "5000"): Response {
  const b64 = Buffer.from(JSON.stringify(challenge(amount))).toString("base64");
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": b64, "content-type": "application/json" },
  });
}

const ok = (tag: string) => new Response(JSON.stringify({ tag }), { status: 200 });
/** A served batch call, with the receipt that states its charge. */
const okWithReceipt = (tag: string) =>
  new Response(JSON.stringify({ tag }), {
    status: 200,
    headers: { "PAYMENT-RESPONSE": Buffer.from("{}").toString("base64") },
  });

type Pay = BatchPayerLike["pay"];

function harness(pay: Pay) {
  const outcomes: BatchOutcome[] = [];
  const payer: BatchPayerLike = { pay: vi.fn(pay), closeFence: vi.fn(async () => 7) };
  const route: SolanaBatchRoute = {
    payer,
    begin: () => 0,
    settle: (_mark, outcome) => void outcomes.push(outcome),
  };
  const sent: Request[] = [];
  const answers: Array<() => Response> = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push(req);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${req.url}`);
    return next();
  });
  const payFetch = createPayFetchWithPreAuth(base, exactClient(), undefined, {
    skipPreAuth: true,
    solanaBatch: route,
  });
  return { payer, outcomes, sent, answers, payFetch };
}

const chatInit = (body: Record<string, unknown> = { model: "openai/gpt-5.4-nano" }) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const paid = (r: Request) => r.headers.has("payment-signature") || r.headers.has("x-payment");

describe("Solana batch-settlement routing", () => {
  it("returns the batch-paid response and never signs exact", async () => {
    const h = harness(async (_pr, send) => {
      const response = await send({ "PAYMENT-SIGNATURE": "batch-auth" });
      return { kind: "paid", response, chargedUsd: 0.0012 };
    });
    h.answers.push(
      () => quote(),
      () => okWithReceipt("batch"),
    );

    const res = await h.payFetch(CHAT, chatInit());

    expect(await res.json()).toEqual({ tag: "batch" });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].headers.get("payment-signature")).toBe("batch-auth");
    expect(h.outcomes).toEqual([{ kind: "paid", chargedMicros: 1200n }]);
    // The close fence was taken and handed to pay().
    expect(vi.mocked(h.payer.pay).mock.calls[0][3]).toBe(7);
  });

  it("pays exact against the fresh challenge when batch falls back", async () => {
    const h = harness(async () => ({
      kind: "fallback",
      reason: "rate_limited",
      paymentRequired: challenge("6000") as never,
    }));
    h.answers.push(
      () => quote("5000"),
      () => ok("exact"),
    );

    const res = await h.payFetch(CHAT, chatInit());

    expect(await res.json()).toEqual({ tag: "exact" });
    expect(h.outcomes).toEqual([{ kind: "not_charged" }]);
    const exactPaid = h.sent.filter(paid);
    expect(exactPaid).toHaveLength(1);
    const signed = JSON.parse(
      Buffer.from(exactPaid[0].headers.get("payment-signature")!, "base64").toString(),
    ) as { accepted: { amount: string } };
    // The fresh challenge's price, not the stale first quote.
    expect(signed.accepted.amount).toBe("6000");
  });

  it("returns a response the fresh challenge served unpaid", async () => {
    const h = harness(async () => ({ kind: "served", response: ok("free") }));
    h.answers.push(() => quote());

    const res = await h.payFetch(CHAT, chatInit());

    expect(await res.json()).toEqual({ tag: "free" });
    expect(h.sent.filter(paid)).toHaveLength(0);
    expect(h.outcomes).toEqual([{ kind: "not_charged" }]);
  });

  it("hands back the fresh challenge's error instead of paying exact", async () => {
    const h = harness(async (_pr, _send, rechallenge) => {
      try {
        await rechallenge();
      } catch (error) {
        return { kind: "failed", error };
      }
      throw new Error("expected the rechallenge to fail");
    });
    h.answers.push(
      () => quote(),
      () => new Response("upstream down", { status: 503 }),
    );

    const res = await h.payFetch(CHAT, chatInit());

    expect(res.status).toBe(503);
    expect(h.sent.filter(paid)).toHaveLength(0);
  });

  it("rethrows a payment in doubt and never pays it again with exact", async () => {
    const inDoubt = Object.assign(new Error("batch payment unresolved"), {
      name: "BatchPaymentUnresolvedError",
    });
    const h = harness(async (_pr, send) => {
      await send({ "PAYMENT-SIGNATURE": "batch-auth" });
      throw inDoubt;
    });
    h.answers.push(
      () => quote(),
      () => new Response("bad gateway", { status: 502 }),
    );

    await expect(h.payFetch(CHAT, chatInit())).rejects.toBe(inDoubt);

    expect(h.outcomes).toEqual([{ kind: "in_doubt" }]);
    // One send, the batch one: no exact payment followed.
    expect(h.sent.filter(paid)).toHaveLength(1);
    expect(h.sent.filter(paid)[0].headers.get("payment-signature")).toBe("batch-auth");
  });

  it("treats a failure after the batch payment was sent as in doubt, whatever it is", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const h = harness(async (_pr, send) => {
      await send({ "PAYMENT-SIGNATURE": "batch-auth" });
      throw abort;
    });
    h.answers.push(
      () => quote(),
      () => ok("lost"),
    );

    const err = await h.payFetch(CHAT, chatInit()).catch((e: unknown) => e);

    expect((err as Error).name).toBe("PaymentInDoubtError");
    expect((err as Error).cause).toBe(abort);
    expect(h.outcomes).toEqual([{ kind: "in_doubt" }]);
    expect(h.sent.filter(paid)).toHaveLength(1);
  });

  it("passes a failure through as unpaid when nothing was sent", async () => {
    const boom = new Error("channel store unwritable");
    const h = harness(async () => {
      throw boom;
    });
    h.answers.push(() => quote());

    await expect(h.payFetch(CHAT, chatInit())).rejects.toBe(boom);
    expect(h.outcomes).toEqual([{ kind: "not_charged" }]);
  });

  it("keeps the ceiling when a paid response carries no receipt", async () => {
    // The payer reports chargedUsd 0 for a 200 without a receipt. Zero proves
    // nothing, so the outcome says "unknown" and the caller keeps the ceiling.
    const h = harness(async (_pr, send) => {
      const response = await send({ "PAYMENT-SIGNATURE": "batch-auth" });
      return { kind: "paid", response, chargedUsd: 0 };
    });
    h.answers.push(
      () => quote(),
      () => ok("no-receipt"),
    );

    await h.payFetch(CHAT, chatInit());

    expect(h.outcomes).toEqual([{ kind: "paid", chargedMicros: undefined }]);
  });

  it("books a stated zero charge when the receipt says so", async () => {
    const h = harness(async (_pr, send) => {
      const response = await send({ "PAYMENT-SIGNATURE": "batch-auth" });
      return { kind: "paid", response, chargedUsd: 0 };
    });
    h.answers.push(
      () => quote(),
      () =>
        new Response("{}", {
          status: 200,
          headers: { "PAYMENT-RESPONSE": Buffer.from("{}").toString("base64") },
        }),
    );

    await h.payFetch(CHAT, chatInit());

    expect(h.outcomes).toEqual([{ kind: "paid", chargedMicros: 0n }]);
  });

  it("keeps streaming chat and other endpoints on exact", async () => {
    const h = harness(async () => {
      throw new Error("the payer must not be called");
    });
    h.answers.push(
      () => quote(),
      () => ok("stream-exact"),
      () => quote(),
      () => ok("image-exact"),
    );

    await h.payFetch(CHAT, chatInit({ model: "openai/gpt-5.4-nano", stream: true }));
    await h.payFetch(
      "https://gw/api/v1/images/generations",
      chatInit({ model: "openai/gpt-image-2" }),
    );

    expect(h.payer.pay).not.toHaveBeenCalled();
    expect(h.sent.filter(paid)).toHaveLength(2);
  });
});
