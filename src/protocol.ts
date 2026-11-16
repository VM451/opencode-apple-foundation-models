export interface BridgeInfo {
  port: number
  token: string
}

export interface HealthResponse {
  status: string
  available: boolean
  reason?: string
  detail?: string
  model: string
  context: number
  compute_target: string
  pcc_state?: string
  pcc_reset_at?: number
  pid: number
}

export const MODEL_ID = "system-language-model"
export const PROVIDER_ID = "apple-fm"

/**
 * PRD models ( §7 ).
 * bridge only serves the on-device endpoint; "hybrid" is an alias that,
 * when combined with hybrid.fallback, delegates heavy prompts to cloud.
 * The hybrid model's advertised limit is larger than the on-device clamp —
 * the bridge enforces the real 4096-token budget regardless.
 */
export const MODEL_ID_HYBRID = "apple-hybrid"
export const MODEL_ID_ON_DEVICE = "apple-on-device"

export interface PccFailoverConfig {
  enabled?: boolean
  defaultCooldownMinutes?: number
  autoSwitchBack?: boolean
  notifyOnSwitch?: boolean
}
