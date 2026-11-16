/**
 * PCC failover state machine (PRD §5.3).
 * Pure, filesystem-agnostic logic; persistence is via the plugin storage
 * + a JSON file at ~/.cache/opencode/apple-fm-state.json (NFR-2).
 */

export interface PccFailoverOptions {
  enabled: boolean
  defaultCooldownMinutes: number
  autoSwitchBack: boolean
  notifyOnSwitch: boolean
}

export interface PccState {
  /** "pcc" = cloud eligible, "on-device" = cooldown active, locked = user forced local */
  activeTarget: "pcc" | "on-device"
  lockedLocal: boolean
  /** ms epoch when PCC resets; 0 = no cooldown */
  resetAt: number | null
  /** ms epoch when next probe should happen */
  nextProbeAt: number | null
  /** Backoff level for exponential probe (0 = immediate) */
  probeBackoffLevel: number
  /** Last detector that triggered failover */
  lastReason?: string
  updatedAt: number
}

export const STATE_FILENAME = "apple-fm-state.json"

export function stateCachePath(homeDir = process.env.HOME ?? "~", platform: NodeJS.Platform = process.platform): string {
  // NFR-2: ~/.cache/opencode/apple-fm-state.json survives OpenCode restarts
  // On macOS/Linux. Cache dir is XDG_CACHE_HOME or ~/.cache.
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return `${xdg}/opencode/${STATE_FILENAME}`
  const home = homeDir === "~" ? (process.env.HOME ?? homeDir) : homeDir
  // XDG default (~/.cache)
  if (platform === "darwin" || platform === "linux") return `${home}/.cache/opencode/${STATE_FILENAME}`
  return `${home}/.cache/opencode/${STATE_FILENAME}`
}

export function defaultPccOptions(raw?: Record<string, any>): PccFailoverOptions {
  const src = raw && typeof raw === "object" ? raw : {}
  return {
    enabled: src.enabled !== false,
    defaultCooldownMinutes: Number(src.defaultCooldownMinutes) > 0 ? Number(src.defaultCooldownMinutes) : 30,
    autoSwitchBack: src.autoSwitchBack !== false,
    notifyOnSwitch: src.notifyOnSwitch !== false,
  }
}

export function initialPccState(now = Date.now()): PccState {
  return {
    activeTarget: "pcc",
    lockedLocal: false,
    resetAt: null,
    nextProbeAt: null,
    probeBackoffLevel: 0,
    updatedAt: now,
  }
}

export function isInCooldown(state: PccState, now = Date.now()): boolean {
  return state.resetAt !== null && now < state.resetAt && state.activeTarget === "on-device"
}

export function remainingMs(state: PccState, now = Date.now()): number {
  if (state.resetAt === null) return 0
  return Math.max(0, state.resetAt - now)
}

/** PRD wants "24m 15s (at 16:08)" style countdown. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s"
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return `${h}h ${String(remM).padStart(2, "0")}m`
}

export function formatResetClock(resetAt: number): string {
  const d = new Date(resetAt)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

export function toastMessageOnFailover(state: PccState, now = Date.now()): string {
  const remaining = formatCountdown(remainingMs(state, now))
  const clock = state.resetAt !== null ? ` (at ${formatResetClock(state.resetAt)})` : ""
  return `PCC usage limit reached. Switched to on-device Apple Foundation Model. PCC resets in ${remaining}${clock}.`
}

export function toastMessageOnReset(): string {
  return "Private Cloud Compute quota has reset! Automatically switched back from on-device Foundation Model to PCC."
}

/** Extract Retry-After / reset timestamp from bridge headers + body (FR-3.1). */
export function parseRetryAfter(
  headers: Record<string, string>,
  body: unknown,
  defaultCooldownMinutes: number,
  now = Date.now(),
): { resetAt: number; source: "header-retry-after" | "body-reset" | "default" } {
  // Header: Retry-After (seconds) or absolute HTTP date
  const retryAfter = headers["retry-after"] || headers["Retry-After"] || headers["x-retry-after"]
  if (retryAfter !== undefined && retryAfter !== null && retryAfter !== "") {
    const num = Number(retryAfter)
    if (Number.isFinite(num) && num >= 0) return { resetAt: now + num * 1000, source: "header-retry-after" }
    const date = Date.parse(String(retryAfter))
    if (Number.isFinite(date)) return { resetAt: date, source: "header-retry-after" }
  }

  // Body: { error: { reset_at | resetAt | expires_at } }
  const err = (body as any)?.error ?? body
  for (const k of ["reset_at", "resetAt", "expires_at", "expiresAt", "reset"]) {
    const v = err?.[k] ?? (body as any)?.[k]
    if (typeof v === "number" && v > 0) {
      // heuristic: >1e12 = ms, >1e9 = seconds
      const at = v > 1e12 ? v : v > 1e9 ? v * 1000 : v * 1000
      return { resetAt: at, source: "body-reset" }
    }
    if (typeof v === "string") {
      const d = Date.parse(v)
      if (Number.isFinite(d)) return { resetAt: d, source: "body-reset" }
    }
  }

  return { resetAt: now + defaultCooldownMinutes * 60_000, source: "default" }
}

/** Whether a bridge error looks like PCC quota / rate limit (FR-3.1).  */
export function isRateLimitError(status: number, body: unknown, headers: Record<string, string>): boolean {
  if (status === 429) return true
  const err = (body as any)?.error ?? body
  const code = String(err?.code ?? err?.type ?? "").toLowerCase()
  const msg = String((body as any)?.error?.message ?? err?.message ?? "").toLowerCase()
  if (code.includes("rate") || code.includes("quota") || code.includes("limit") || code.includes("throttl") || code === "pcc_limit" || code === "generation_rate_limited") return true
  if (msg.includes("rate limit") || msg.includes("quota") || msg.includes("pcc") || msg.includes("throttl") || msg.includes("usage limit")) return true
  if (status === 503 && (headers["x-apple-compute-target"] === "pcc" || msg.includes("pcc"))) return true
  return false
}

/** State transition: PCC hit limit → on-device cooldown. */
export function applyFailover(state: PccState, resetAt: number, now = Date.now(), reason = "rate_limited"): PccState {
  return {
    ...state,
    activeTarget: "on-device",
    resetAt,
    nextProbeAt: resetAt,
    probeBackoffLevel: 0,
    lastReason: reason,
    updatedAt: now,
  }
}

/** State transition: cooldown expired + probe succeeded → back to PCC (if autoSwitchBack). */
export function applySwitchBack(state: PccState, now = Date.now(), opts?: { probeSucceeded?: boolean }): PccState {
  if (state.lockedLocal) return { ...state, updatedAt: now }
  const eligible = opts?.probeSucceeded !== false
  if (!eligible) return state
  if (!state.resetAt || now < state.resetAt) return state
  return {
    ...state,
    activeTarget: "pcc",
    resetAt: null,
    nextProbeAt: null,
    probeBackoffLevel: 0,
    updatedAt: now,
  }
}

/** Parse /pcc-status --lock-local / --unlock */
export function parseLockCommand(args: string): "lock" | "unlock" | null {
  const a = args.trim().toLowerCase()
  if (a.includes("--lock-local") || a.includes("--lock")) return "lock"
  if (a.includes("--unlock") || a.includes("--unlock-local") || a.includes("--auto")) return "unlock"
  return null
}
