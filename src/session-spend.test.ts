import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "./session.js";
import { CostCapError, SessionSpend, parseMicros, usdToMicros } from "./session-spend.js";
import { SpendPolicyError } from "./spend-control.js";

const CAP = 12_000n;
const stores: SessionStore[] = [];
function newStore(): SessionStore {
  const store = new SessionStore();
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function admit(store: SessionStore, est: bigint, id = "s"): SessionSpend {
  const a = SessionSpend.admit(store, id, CAP, est);
  if (!a.admitted) throw new Error("expected admission");
  return a.spend;
}

describe("SessionSpend", () => {
  it("holds the estimate at admission, so a concurrent request sees it", () => {
    const store = newStore();
    admit(store, 8_000n);
    expect(store.getSessionHoldMicros("s")).toBe(8_000n);
    const second = SessionSpend.admit(store, "s", CAP, 8_000n);
    expect(second.admitted).toBe(false);
  });

  it("records a signed payment as spend immediately and swaps it for the hold", () => {
    const store = newStore();
    const spend = admit(store, 8_500n);
    expect(spend.coverPayment(8_000n)).toBe(true);
    spend.recordSigned(8_000n);
    expect(store.getSessionCostMicros("s")).toBe(8_000n);
    expect(store.getSessionHoldMicros("s")).toBe(500n);
  });

  it("refuses a second signature after a paid failure", () => {
    const store = newStore();
    const spend = admit(store, 8_500n);
    spend.recordSigned(8_000n); // settled, response lost
    expect(spend.coverPayment(8_000n)).toBe(false);
  });

  it("counts other requests' holds, not its own, when covering a payment", () => {
    const store = newStore();
    const a = admit(store, 4_000n);
    admit(store, 4_000n);
    expect(a.coverPayment(8_001n)).toBe(false);
    expect(a.coverPayment(8_000n)).toBe(true); // 0 spent + 4000 other + 8000 = cap
  });

  it("reserves the quote as it checks, so two requests cannot both pass", () => {
    const store = newStore();
    const a = admit(store, 4_000n);
    const b = admit(store, 4_000n);
    expect(a.coverPayment(8_000n)).toBe(true);
    expect(store.getSessionHoldMicros("s")).toBe(12_000n);
    expect(b.coverPayment(8_000n)).toBe(false); // was true: 16000 against 12000
  });

  it("takes back a declined payment once, and only the latest one", () => {
    const store = newStore();
    const spend = admit(store, 8_000n);
    spend.recordSigned(3_000n);
    spend.recordSigned(4_000n);
    spend.voidLastSigned();
    spend.voidLastSigned(); // a second decline report cannot undo the first payment
    expect(store.getSessionCostMicros("s")).toBe(3_000n);
  });

  it("records the estimate on success only when nothing was signed", () => {
    const store = newStore();
    const unsigned = admit(store, 8_000n, "key-rail");
    unsigned.recordSuccess(8_000n);
    expect(store.getSessionCostMicros("key-rail")).toBe(8_000n);

    const signed = admit(store, 8_000n, "wallet");
    signed.recordSigned(7_000n);
    signed.recordSuccess(8_000n);
    expect(store.getSessionCostMicros("wallet")).toBe(7_000n);
  });

  it("release returns the remaining hold once", () => {
    const store = newStore();
    const spend = admit(store, 8_000n);
    spend.recordSigned(3_000n);
    spend.release();
    spend.release();
    expect(store.getSessionHoldMicros("s")).toBe(0n);
    expect(store.getSessionCostMicros("s")).toBe(3_000n);
  });

  it("graceful tracking records spend but never refuses", () => {
    const store = newStore();
    store.addSessionCost("g", 50_000n);
    const spend = SessionSpend.track(store, "g");
    expect(spend.isStrict).toBe(false);
    expect(spend.coverPayment(1_000_000n)).toBe(true);
    spend.recordSigned(8_000n);
    expect(store.getSessionCostMicros("g")).toBe(58_000n);
  });
});

describe("helpers", () => {
  it("parseMicros accepts only canonical decimal strings", () => {
    expect(parseMicros("8000")).toBe(8_000n);
    for (const bad of [undefined, "", "-1", "1.5", "1e3", " 8", "0x10"]) {
      expect(parseMicros(bad)).toBeUndefined();
    }
  });

  it("usdToMicros rounds rather than truncating", () => {
    expect(usdToMicros(0.012)).toBe(12_000n);
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000n);
  });

  it("CostCapError is a SpendPolicyError, so pre-auth treats it as final", () => {
    expect(new CostCapError("x")).toBeInstanceOf(SpendPolicyError);
  });
});

describe("parseQuotedAmountMicros", () => {
  it("reads v2 amount and v1 maxAmountRequired, rejects the rest", async () => {
    const { parseQuotedAmountMicros } = await import("./spend-control.js");
    expect(parseQuotedAmountMicros({ amount: "8000" })).toBe(8_000n);
    expect(parseQuotedAmountMicros({ maxAmountRequired: "8000" })).toBe(8_000n);
    expect(parseQuotedAmountMicros({ amount: "0x1F40" })).toBeUndefined();
    expect(parseQuotedAmountMicros({})).toBeUndefined();
  });
});
