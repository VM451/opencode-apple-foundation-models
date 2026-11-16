export interface FallbackTarget {
  providerID: string
  modelID: string
}

export interface RoutingOptions {
  /** Estimated prompt tokens above which a request is considered "heavy". */
  threshold: number
  fallback?: FallbackTarget
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3))
}

const HEAVY_PATTERN = /\b(refactor|rewrite|whole project|whole codebase|whole repo|multiple files|entire codebase|all files)\b/i

export function isHeavyPrompt(text: string, options: RoutingOptions): boolean {
  if (!options.fallback) return false
  return estimateTokens(text) > options.threshold || HEAVY_PATTERN.test(text)
}

/** Sliding-window trim for local callers that need to stay under a context budget. */
export function trimToBudget<T extends { role: string; text: string }>(
  messages: readonly T[],
  budget: number,
  reserve = 256,
): { messages: T[]; removed: number } {
  const system = messages.filter((m) => m.role === "system")
  const rest = messages.filter((m) => m.role !== "system")
  const kept = [...rest]
  let removed = 0
  const total = () => system.reduce((n, m) => n + estimateTokens(m.text), 0)
    + kept.reduce((n, m) => n + estimateTokens(m.text) + 4, 0)

  while (total() > budget - reserve && kept.length > 2) {
    kept.shift()
    removed++
  }
  return { messages: [...system, ...kept], removed }
}
