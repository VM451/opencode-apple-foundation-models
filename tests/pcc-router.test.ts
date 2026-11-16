import { describe, expect, test } from "bun:test"
import { MODEL_ID_HYBRID, MODEL_ID_ON_DEVICE } from "../src/protocol"

describe("prism models", () => {
  test("hybrid and on-device ids match PRD config", () => {
    expect(MODEL_ID_HYBRID).toBe("apple-hybrid")
    expect(MODEL_ID_ON_DEVICE).toBe("apple-on-device")
  })
})
