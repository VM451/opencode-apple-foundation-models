import { describe, expect, test } from "bun:test"
import {
  applyFailover,
  applySwitchBack,
  formatCountdown,
  formatResetClock,
  isInCooldown,
  isRateLimitError,
  parseLockCommand,
  parseRetryAfter,
  remainingMs,
  toastMessageOnFailover,
  toastMessageOnReset,
  initialPccState,
  stateCachePath,
} from "../src/pcc-state"

describe("pcc-state", () => {
  test("initial state is PCC", () => {
    const s = initialPccState(1000)
    expect(s.activeTarget).toBe("pcc")
    expect(s.resetAt).toBeNull()
    expect(isInCooldown(s, 1000)).toBe(false)
  })

  test("formatCountdown formats seconds / minutes / hours", () => {
    expect(formatCountdown(0)).toBe("0s")
    expect(formatCountdown(5000)).toBe("5s")
    expect(formatCountdown(145000)).toBe("2m 25s")
    expect(formatCountdown(3700000)).toBe("1h 01m")
    expect(formatCountdown(245*1000 + 15000)).toBe("4m 20s")
  })

  test("formatResetClock produces HH:MM", () => {
    const d = new Date(2026, 0, 1, 16, 8)
    expect(formatResetClock(d.getTime())).toBe("16:08")
  })

  test("remaining + isInCooldown + failover / switchback", () => {
    const now = 1_000_000
    let s = initialPccState(now)
    s = applyFailover(s, now + 60_000, now, "test")
    expect(s.activeTarget).toBe("on-device")
    expect(isInCooldown(s, now)).toBe(true)
    expect(remainingMs(s, now)).toBe(60_000)
    expect(isInCooldown(s, now + 61_000)).toBe(false)
    s = applySwitchBack(s, now + 61_000)
    expect(s.activeTarget).toBe("pcc")
    expect(s.resetAt).toBeNull()
  })

  test("lockedLocal blocks switchback", () => {
    const now = 1_000_000
    let s: import("../src/pcc-state").PccState = { ...initialPccState(now), lockedLocal: true, activeTarget: "on-device" as const, resetAt: now + 1000 }
    s = applySwitchBack(s, now + 2000)
    expect(s.lockedLocal).toBe(true)
    // still on-device because locked
    expect(s.activeTarget).toBe("on-device")
  })

  test("parseRetryAfter: header seconds, header date, body, default", () => {
    const now = 1_000_000
    expect(parseRetryAfter({ "retry-after": "120" }, null, 30, now)).toEqual({ resetAt: now + 120_000, source: "header-retry-after" })
    const d = new Date(now + 5000).toUTCString()
    expect(parseRetryAfter({ "retry-after": d }, null, 30, now).source).toBe("header-retry-after")
    expect(parseRetryAfter({}, { error: { reset_at: now + 9999 } }, 30, now).source).toBe("body-reset")
    expect(parseRetryAfter({}, null, 30, now)).toEqual({ resetAt: now + 30 * 60_000, source: "default" })
  })

  test("isRateLimitError detects 429 and pcc messages", () => {
    expect(isRateLimitError(429, {}, {})).toBe(true)
    expect(isRateLimitError(200, { error: { code: "rate_limited" } }, {})).toBe(true)
    expect(isRateLimitError(200, { error: { message: "PCC usage limit reached" } }, {})).toBe(true)
    expect(isRateLimitError(200, { error: { message: "quota exceeded" } }, {})).toBe(true)
    expect(isRateLimitError(503, { error: { message: "ok" } }, { "x-apple-compute-target": "pcc" })).toBe(true)
    expect(isRateLimitError(200, { error: { message: "ok" } }, {})).toBe(false)
  })

  test("parseLockCommand", () => {
    expect(parseLockCommand("--lock-local")).toBe("lock")
    expect(parseLockCommand("--lock")).toBe("lock")
    expect(parseLockCommand("--unlock")).toBe("unlock")
    expect(parseLockCommand("")).toBeNull()
  })

  test("toast messages contain countdown and clock", () => {
    const now = 1_000_000
    let s = applyFailover(initialPccState(now), now + 1455000, now)
    const msg = toastMessageOnFailover(s, now)
    expect(msg).toContain("PCC usage limit")
    expect(msg).toContain("on-device")
    expect(msg).toContain(formatCountdown(1455000))
    expect(toastMessageOnReset()).toContain("Private Cloud Compute")
  })

  test("stateCachePath respects XDG and HOME", () => {
    const prev = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = "/tmp/xdg"
    expect(stateCachePath()).toBe("/tmp/xdg/opencode/apple-fm-state.json")
    delete process.env.XDG_CACHE_HOME
    if (prev) process.env.XDG_CACHE_HOME = prev
  })
})
