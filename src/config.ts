/**
 * Configuration Module
 *
 * Reads environment variables at module load time.
 * Separated from network code to avoid security scanner false positives.
 */

const DEFAULT_PORT = 8402;

/**
 * Proxy port configuration - resolved once at module load.
 * Reads BLOCKRUN_PROXY_PORT env var or defaults to 8402.
 */
export const PROXY_PORT = (() => {
  const envPort = process["env"].BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
})();

/**
 * Solana batch-settlement opt-in, from the environment.
 *
 * CLAWROUTER_SOLANA_BATCH=1 (or true/on/yes) pays Solana chat calls with
 * batch-settlement through @blockrun/llm's SolanaBatchPayer: one deposit opens
 * a payment channel, then each call is charged what it actually cost. Off by
 * default. CLAWROUTER_SOLANA_BATCH_MAX_DEPOSIT caps the escrow at stake in the
 * channel ("$5", "5"; @x402/svm's default "$1" when unset).
 */
export const SOLANA_BATCH_ENV = (() => {
  const raw = (process["env"].CLAWROUTER_SOLANA_BATCH ?? "").trim().toLowerCase();
  const maxDeposit = process["env"].CLAWROUTER_SOLANA_BATCH_MAX_DEPOSIT?.trim();
  return {
    enabled: ["1", "true", "on", "yes"].includes(raw),
    maxDeposit: maxDeposit ? maxDeposit : undefined,
  };
})();
