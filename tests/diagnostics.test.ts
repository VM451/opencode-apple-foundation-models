import { describe, expect, test } from "bun:test"
import { diagnosticMessage } from "../src/diagnostics"
import type { HealthResponse } from "../src/protocol"

const base: HealthResponse = {
  status: "ok", available: true, model: "system-language-model",
  context: 4096, compute_target: "on-device", pid: 1,
}

describe("diagnostics", () => {
  test("silent when available", () => {
    expect(diagnosticMessage(base)).toBe("")
  })

  test("actionable messages per reason", () => {
    expect(diagnosticMessage({ ...base, available: false, reason: "apple_intelligence_disabled" })).toContain("System Settings")
    expect(diagnosticMessage({ ...base, available: false, reason: "model_not_ready" })).toContain("downloading")
    expect(diagnosticMessage({ ...base, available: false, reason: "device_not_eligible" })).toContain("Apple Silicon")
  })

  test("startup failure", () => {
    expect(diagnosticMessage(null, new Error("boom"))).toContain("boom")
  })
})
