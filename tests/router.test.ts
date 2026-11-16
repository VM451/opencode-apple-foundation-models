import { describe, expect, test } from "bun:test"
import { estimateTokens, isHeavyPrompt, trimToBudget } from "../src/router"

describe("router", () => {
  test("estimates tokens from characters", () => {
    expect(estimateTokens("abc")).toBe(1)
    expect(estimateTokens("a".repeat(300))).toBe(100)
  })

  test("routes heavy prompts only when a fallback exists", () => {
    expect(isHeavyPrompt("hi", { threshold: 10 })).toBe(false)
    expect(isHeavyPrompt("a".repeat(9000), { threshold: 10, fallback: { providerID: "x", modelID: "y" } })).toBe(true)
    expect(isHeavyPrompt("please refactor this file", { threshold: 10_000, fallback: { providerID: "x", modelID: "y" } })).toBe(true)
  })

  test("trims oldest turns but keeps system", () => {
    const messages = [
      { role: "system", text: "rules" },
      { role: "user", text: "old".repeat(20) },
      { role: "assistant", text: "answer".repeat(20) },
      { role: "user", text: "new" },
    ]
    const result = trimToBudget(messages, 60, 0)
    expect(result.messages[0].role).toBe("system")
    expect(result.messages.at(-1)?.text).toBe("new")
    expect(result.removed).toBeGreaterThan(0)
  })
})
