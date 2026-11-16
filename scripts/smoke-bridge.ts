// Optional live smoke test: requires the bridge binary and an available model.
// Run: bun scripts/smoke-bridge.ts
import { BridgeManager } from "../src/bridge"
import { resolve } from "node:path"

const manager = new BridgeManager({
  bridgePath: resolve(import.meta.dir, "../swift/.build/release/apple-fm-bridge"),
  context: 4096,
  maxOutput: 128,
})

await manager.start()
const health = await manager.health()
console.log("health:", health)

async function chat(body: Record<string, unknown>) {
  const res = await fetch(`${manager.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${manager.token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, target: res.headers.get("x-apple-compute-target"), body: await res.json() }
}

console.log("plain:", await chat({ messages: [{ role: "user", content: "Reply with exactly: PONG" }], max_tokens: 32 }))
console.log("tool:", await chat({
  messages: [{ role: "user", content: "Weather in Paris?" }],
  max_tokens: 64,
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }],
}))
await manager.stop()
