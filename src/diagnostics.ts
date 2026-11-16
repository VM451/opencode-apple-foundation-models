import type { HealthResponse } from "./protocol"

export function diagnosticMessage(health: HealthResponse | null, error?: unknown): string {
  if (error) {
    return `[apple-fm] Bridge failed to start: ${errorMessage(error)}. The apple-fm provider is unavailable.`
  }
  if (!health) {
    return "[apple-fm] Bridge started but health check failed. Check `opencode` server logs; the apple-fm provider is unavailable."
  }
  if (health.available) return ""

  switch (health.reason) {
    case "device_not_eligible":
      return "[apple-fm] This Mac is not eligible for on-device Foundation Models. Requires Apple Silicon (M1+) with macOS 26+."
    case "apple_intelligence_disabled":
      return "[apple-fm] Apple Intelligence is off. Enable it in System Settings > Apple Intelligence & Siri, then restart OpenCode."
    case "model_not_ready":
      return "[apple-fm] Foundation Model assets are still downloading. Check System Settings > Apple Intelligence & Siri; retry when ready."
    default:
      return `[apple-fm] Foundation Model unavailable: ${health.detail ?? health.reason ?? "unknown reason"}.`
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
