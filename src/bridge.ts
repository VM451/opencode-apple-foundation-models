import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { BridgeInfo, HealthResponse } from "./protocol"

export interface BridgeOptions {
  port?: number
  context?: number
  maxOutput?: number
  bridgePath?: string
  startTimeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class BridgeManager {
  private proc?: ChildProcess
  private info?: BridgeInfo
  private infoPath?: string
  private stderr = ""
  private readonly timeout: number

  constructor(private readonly options: BridgeOptions) {
    this.timeout = options.startTimeoutMs ?? 15_000
  }

  get baseURL(): string {
    if (!this.info) throw new Error("Bridge not started")
    return `http://127.0.0.1:${this.info.port}/v1`
  }

  get token(): string {
    if (!this.info) throw new Error("Bridge not started")
    return this.info.token
  }

  async start(): Promise<BridgeInfo> {
    if (this.info && this.proc && this.proc.exitCode === null) return this.info

    if (process.platform !== "darwin") {
      throw new Error("Apple Foundation Models requires macOS 26+ on Apple Silicon.")
    }

    const binary = this.resolveBinary()
    const token = `${randomUUID()}${randomUUID()}`
    const infoPath = join(tmpdir(), `apple-fm-bridge-${randomUUID()}.json`)
    this.infoPath = infoPath
    this.stderr = ""

    const args = [
      "--token", token,
      "--info-file", infoPath,
      "--port", String(this.options.port ?? 0),
      "--context", String(this.options.context ?? 4096),
      "--max-output", String(this.options.maxOutput ?? 1024),
    ]

    this.proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] })
    this.proc.stderr?.setEncoding("utf8")
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
      if (process.env.APPLE_FM_DEBUG) process.stderr.write(chunk)
    })
    this.proc.on("exit", () => { this.info = undefined })

    const deadline = Date.now() + this.timeout
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) {
        throw new Error(`apple-fm-bridge exited (${this.proc.exitCode}): ${this.stderr.trim() || "no stderr"}`)
      }
      try {
        const raw = await readFile(infoPath, "utf8")
        const parsed = JSON.parse(raw) as BridgeInfo
        if (typeof parsed.port === "number" && typeof parsed.token === "string") {
          this.info = parsed
          return parsed
        }
      } catch {
        // info file not written yet
      }
      await sleep(100)
    }
    this.stop()
    throw new Error(`Timed out starting apple-fm-bridge: ${this.stderr.trim() || "no output"}`)
  }

  async health(): Promise<HealthResponse | null> {
    if (!this.info) return null
    try {
      const res = await fetch(`${this.baseURL.replace(/\/v1$/, "")}/health`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return null
      return (await res.json()) as HealthResponse
    } catch {
      return null
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.info = undefined
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM")
      await Promise.race([
        new Promise<void>((r) => proc.once("exit", () => r())),
        sleep(2000).then(() => { if (proc.exitCode === null) proc.kill("SIGKILL") }),
      ])
    }
    if (this.infoPath) {
      await unlink(this.infoPath).catch(() => {})
      this.infoPath = undefined
    }
  }

  private resolveBinary(): string {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      this.options.bridgePath,
      process.env.APPLE_FM_BRIDGE_PATH,
      resolve(here, "../bin/apple-fm-bridge"),
      resolve(here, "../swift/.build/release/apple-fm-bridge"),
    ].filter((p): p is string => Boolean(p))

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    throw new Error(
      `apple-fm-bridge binary not found. Run \`npm run build:swift\` in the plugin directory, ` +
      `or set bridgePath / APPLE_FM_BRIDGE_PATH. Tried: ${candidates.join(", ")}`,
    )
  }
}
