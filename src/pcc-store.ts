import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { defaultPccOptions, initialPccState, stateCachePath, type PccState } from "./pcc-state"

/**
 * Persistent PCC state at ~/.cache/opencode/apple-fm-state.json (NFR-2) + plugin storage fallback.
 * Storage via ctx.storage is the primary channel (cross-process), the JSON file
 * is the PRD-mandated restartsurvival copy.
 */
export class PccStore {
  private state: PccState
  private readonly path: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(path: string, initial: PccState) {
    this.path = path
    this.state = initial
  }

  get current(): PccState {
    return this.state
  }

  set(next: PccState) {
    this.state = { ...next, updatedAt: Date.now() }
    this.persist()
  }

  async load(ctx?: { storage?: { get: (k: string) => Promise<any>; set?: (k: string, v: any) => Promise<void> } }): Promise<PccState> {
    // 1) File
    try {
      const raw = await readFile(this.path, "utf8")
      const parsed = JSON.parse(raw) as Partial<PccState>
      if (parsed && typeof parsed === "object") {
        this.state = { ...initialPccState(), ...parsed, updatedAt: parsed.updatedAt ?? Date.now() }
        return this.state
      }
    } catch {}
    // 2) Plugin storage fallback
    if (ctx?.storage?.get) {
      try {
        const v = await ctx.storage.get("apple-fm.state")
        if (v && typeof v === "object") {
          this.state = { ...initialPccState(), ...v }
          await this.persist()
          return this.state
        }
      } catch {}
    }
    return this.state
  }

  persist(): Promise<void> {
    // Fire-and-forget with chained writes (never blocks inference path)
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        // compact write; atomic via temp + rename in older code kept simple
        await writeFile(this.path, JSON.stringify(this.state, null, 2), "utf8")
      } catch {}
    })
    return this.writeChain
  }

  async persistAndMirror(mirror?: (state: PccState) => Promise<void>): Promise<void> {
    await this.persist()
    if (mirror) {
      try { await mirror(this.state) } catch {}
    }
  }
}

export function createPccStore(): PccStore {
  const path = stateCachePath()
  return new PccStore(path, initialPccState())
}
