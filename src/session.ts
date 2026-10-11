/**
 * Session Persistence Store
 *
 * Tracks model selections per session to prevent model switching mid-task.
 * When a session is active, the router will continue using the same model
 * instead of re-routing each request.
 */

import { createHash } from "node:crypto";

export type SessionEntry = {
  model: string;
  tier: string;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  /**
   * `true` when the user explicitly chose this model (e.g. /model command in
   * OpenClaw or sending an explicit non-profile model in the request body).
   * Explicit pins are sticky — they're NOT overridden by tier escalation when
   * a future routing-profile request comes in. The user's intent wins.
   */
  userExplicit?: boolean;
  // --- Three-strike escalation ---
  recentHashes: string[]; // Sliding window of last 3 request content fingerprints
  strikes: number; // Consecutive similar request count
  escalated: boolean; // Whether session was already escalated via three-strike
  // --- Cost accumulation for maxCostPerRun ---
  sessionCostMicros: bigint; // Total estimated cost for this session run (USDC 6-decimal)
};

export type SessionConfig = {
  /** Enable session persistence (default: false) */
  enabled: boolean;
  /** Session timeout in ms (default: 30 minutes) */
  timeoutMs: number;
  /** Header name for session ID (default: X-Session-ID) */
  headerName: string;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  enabled: true,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
  headerName: "x-session-id",
};

/**
 * Session persistence store for maintaining model selections.
 */
export class SessionStore {
  private sessions: Map<string, SessionEntry> = new Map();
  // Kept apart from `sessions`: a hold belongs to requests still running, so it
  // must not vanish when the idle-session sweep drops an entry mid-request.
  private sessionHolds: Map<string, bigint> = new Map();
  private config: SessionConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };

    // Start cleanup interval (every 5 minutes)
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }

  /**
   * Get the pinned model for a session, if any.
   */
  getSession(sessionId: string): SessionEntry | undefined {
    if (!this.config.enabled || !sessionId) {
      return undefined;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }

    // Check if session has expired
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return entry;
  }

  /**
   * Pin a model to a session.
   *
   * Pass `userExplicit: true` when the user explicitly chose this model
   * (e.g. via /model command or by sending an explicit non-profile model).
   * Explicit pins are sticky — they survive tier-escalation comparisons so
   * that the user's choice keeps winning even if subsequent requests use a
   * routing profile that would normally re-route.
   */
  setSession(sessionId: string, model: string, tier: string, userExplicit?: boolean): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const existing = this.sessions.get(sessionId);
    const now = Date.now();

    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      // Update model if different (e.g., fallback)
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
      // Promote to explicit if the latest call upgraded it; do not silently
      // demote an existing explicit pin to auto-routed.
      if (userExplicit) {
        existing.userExplicit = true;
      }
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1,
        userExplicit: userExplicit || undefined,
        recentHashes: [],
        strikes: 0,
        escalated: false,
        sessionCostMicros: 0n,
      });
    }
  }

  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId: string): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }

  /**
   * Clear a specific session.
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get session stats for debugging.
   */
  getStats(): { count: number; sessions: Array<{ id: string; model: string; age: number }> } {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1000),
    }));
    return { count: this.sessions.size, sessions };
  }

  /**
   * Clean up expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Record a request content hash and detect repetitive patterns.
   * Returns true if escalation should be triggered (3+ consecutive similar requests).
   */
  recordRequestHash(sessionId: string, hash: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    const prev = entry.recentHashes;
    if (prev.length > 0 && prev[prev.length - 1] === hash) {
      entry.strikes++;
    } else {
      entry.strikes = 0;
    }

    entry.recentHashes.push(hash);
    if (entry.recentHashes.length > 3) {
      entry.recentHashes.shift();
    }

    return entry.strikes >= 2 && !entry.escalated;
  }

  /**
   * Escalate session to next tier. Returns the new model/tier or null if already at max.
   */
  escalateSession(
    sessionId: string,
    tierConfigs: Record<string, { primary: string; fallback: string[] }>,
  ): { model: string; tier: string } | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;

    const TIER_ORDER = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
    const currentIdx = TIER_ORDER.indexOf(entry.tier);
    if (currentIdx < 0 || currentIdx >= TIER_ORDER.length - 1) return null;

    const nextTier = TIER_ORDER[currentIdx + 1];
    const nextConfig = tierConfigs[nextTier];
    if (!nextConfig) return null;

    entry.model = nextConfig.primary;
    entry.tier = nextTier;
    entry.strikes = 0;
    entry.escalated = true;

    return { model: nextConfig.primary, tier: nextTier };
  }

  /**
   * Add cost to a session's running total for maxCostPerRun tracking.
   * Cost is in USDC 6-decimal units (micros).
   * Creates a cost-tracking-only entry if none exists (e.g., explicit model requests
   * that never go through the routing path).
   */
  addSessionCost(sessionId: string, additionalMicros: bigint): void {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const now = Date.now();
      entry = {
        model: "",
        tier: "DIRECT",
        createdAt: now,
        lastUsedAt: now,
        requestCount: 0,
        recentHashes: [],
        strikes: 0,
        escalated: false,
        sessionCostMicros: 0n,
      };
      this.sessions.set(sessionId, entry);
    }
    entry.sessionCostMicros += additionalMicros;
    // A negative adjustment (a signed payment the gateway declined) can only
    // undo what was recorded, never push the total below zero.
    if (entry.sessionCostMicros < 0n) entry.sessionCostMicros = 0n;
  }

  /**
   * Get the total accumulated cost for a session in USD.
   */
  getSessionCostUsd(sessionId: string): number {
    return Number(this.getSessionCostMicros(sessionId)) / 1_000_000;
  }

  /**
   * Get the total accumulated cost for a session in USDC micros.
   */
  getSessionCostMicros(sessionId: string): bigint {
    return this.sessions.get(sessionId)?.sessionCostMicros ?? 0n;
  }

  /**
   * Budget held by a session's in-flight requests (USDC micros) — admitted
   * against the strict cap but not yet spent. See session-spend.ts.
   */
  getSessionHoldMicros(sessionId: string): bigint {
    return this.sessionHolds.get(sessionId) ?? 0n;
  }

  /**
   * Grow (positive) or release (negative) a session's in-flight hold.
   */
  adjustSessionHold(sessionId: string, deltaMicros: bigint): void {
    const next = (this.sessionHolds.get(sessionId) ?? 0n) + deltaMicros;
    if (next > 0n) this.sessionHolds.set(sessionId, next);
    else this.sessionHolds.delete(sessionId);
  }

  /**
   * Stop the cleanup interval.
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Generate a session ID from request headers or create a default.
 */
export function getSessionId(
  headers: Record<string, string | string[] | undefined>,
  headerName: string = DEFAULT_SESSION_CONFIG.headerName,
): string | undefined {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

/**
 * Derive a stable session ID from message content when no explicit session
 * header is provided. Uses the first user message as the conversation anchor —
 * same opening message = same session ID across all subsequent turns.
 *
 * This prevents model-switching mid-conversation even when OpenClaw doesn't
 * send an x-session-id header (which is the default OpenClaw behaviour).
 */
export function deriveSessionId(
  messages: Array<{ role: string; content: unknown }>,
): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;

  const content =
    typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);

  // 8-char hex prefix of SHA-256 — short enough for logs, collision-resistant
  // enough for session tracking within a single gateway instance.
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Generate a short hash fingerprint from request content.
 * Captures: last user message text + tool call names (if any).
 * Normalizes whitespace to avoid false negatives from minor formatting diffs.
 */
export function hashRequestContent(lastUserContent: string, toolCallNames?: string[]): string {
  const normalized = lastUserContent.replace(/\s+/g, " ").trim().slice(0, 500);
  const toolSuffix = toolCallNames?.length ? `|tools:${toolCallNames.sort().join(",")}` : "";
  return createHash("sha256")
    .update(normalized + toolSuffix)
    .digest("hex")
    .slice(0, 12);
}
