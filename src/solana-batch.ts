/**
 * Solana batch-settlement, paid by @blockrun/llm's SolanaBatchPayer.
 *
 * `exact` signs one SPL transfer per call at the call's ceiling (the quote for
 * `max_tokens`). `batch-settlement` opens a deposit-backed channel once; each
 * call then carries a signed authorization for its ceiling, and the gateway
 * charges what the call actually cost. ClawRouter does not implement the
 * protocol: it uses the same payer `SolanaLLMClient` ships, so both clients
 * share one hardened path (in-doubt payments are never replaced, the channel
 * file is locked across processes, 429s cool the wallet down, a refused
 * deposit parks the wallet on exact).
 *
 * The channel's voucher signer is BlockRun's operator key, pinned here as the
 * only trusted operator. The deposit is escrow under that key, bounded by
 * `maxDeposit`; spend is the per-call charge. ClawRouter's own spend rules
 * (SpendControl, the strict session cap) see each batch payment at its
 * per-call ceiling through `configureClient`, exactly as they see `exact`
 * payments, and only when the user configured them.
 */

import bs58 from "bs58";
import type { SolanaBatchPayer, X402ClientLike } from "@blockrun/llm";

/** Replay budget for a batch payment in doubt (see createSolanaBatchPayer). */
export const IN_DOUBT_MAX_WAIT_MS = 20_000;

export interface SolanaBatchSettings {
  /** Escrow cap per channel, e.g. "$5". Unset: @x402/svm's default ("$1"). */
  maxDeposit?: string | number;
  /**
   * Operator keys trusted to sign vouchers. Default: BlockRun's
   * (`BLOCKRUN_SOL_OPERATOR`). Only for a key rotation, when both keys are
   * valid for a while. Never trust the operator a 402 names.
   */
  operators?: string[];
  /**
   * Where open-channel state is kept: a file path, or `false` for memory only.
   * Default: @blockrun/llm's `~/.blockrun/solana-batch/<address>.json`, locked
   * to one process at a time.
   */
  channelStore?: string | false;
  /** @internal Replay budget for a payment in doubt, in ms (tests shorten it). */
  inDoubtMaxWaitMs?: number;
}

/**
 * The batch settings to use, or undefined when batch is off. An explicit
 * `ProxyOptions.solanaBatch` wins over the environment.
 */
export function resolveSolanaBatchSettings(
  option: boolean | SolanaBatchSettings | undefined,
  env: { enabled: boolean; maxDeposit?: string },
): SolanaBatchSettings | undefined {
  if (option === false) return undefined;
  if (option === true) return env.maxDeposit ? { maxDeposit: env.maxDeposit } : {};
  if (option) return option;
  if (!env.enabled) return undefined;
  return env.maxDeposit ? { maxDeposit: env.maxDeposit } : {};
}

/**
 * Build the payer for this wallet. `seed` is ClawRouter's 32-byte Solana key
 * and `address` its public key; the payer wants the 64-byte keypair form.
 */
export async function createSolanaBatchPayer(init: {
  seed: Uint8Array;
  address: string;
  rpcUrl: string;
  settings: SolanaBatchSettings;
  configureClient: (client: X402ClientLike) => void;
}): Promise<SolanaBatchPayer> {
  const { SolanaBatchPayer, BLOCKRUN_SOL_OPERATOR } = await import("@blockrun/llm");
  const publicKey = bs58.decode(init.address);
  if (init.seed.length !== 32 || publicKey.length !== 32) {
    throw new Error("Solana batch-settlement needs a 32-byte seed and a 32-byte public key");
  }
  const keypair = new Uint8Array(64);
  keypair.set(init.seed, 0);
  keypair.set(publicKey, 32);
  return new SolanaBatchPayer({
    options: {
      operators: init.settings.operators?.length
        ? init.settings.operators
        : [BLOCKRUN_SOL_OPERATOR],
      // How long one call keeps replaying a payment in doubt before it gives
      // up. The SDK default (5 min) suits a client that waits for its answer;
      // here the request has a deadline, and once it is aborted every replay
      // reuses the aborted signal, so a long budget only keeps the wallet's
      // channel busy for nothing.
      inDoubt: { maxWaitMs: init.settings.inDoubtMaxWaitMs ?? IN_DOUBT_MAX_WAIT_MS },
      ...(init.settings.maxDeposit !== undefined ? { maxDeposit: init.settings.maxDeposit } : {}),
      ...(init.settings.channelStore !== undefined
        ? { channelStore: init.settings.channelStore }
        : {}),
    },
    secretKey: async () => keypair,
    address: async () => init.address,
    rpcUrl: init.rpcUrl,
    configureClient: init.configureClient,
  });
}
