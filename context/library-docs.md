# Library Docs

- Stack: TypeScript 5.7 + Bun 1.1 (`bun:test`, `bun-types`), Swift 6.2 (`swift-tools-version: 6.2`, `macOS .v26`), Node >=20, `npm`.
- `@opencode/plugin@^2.3.0`: `Plugin.define({id, setup})`, `ctx.provider.transform` (two-model + legacy), `ctx.command.transform` (`/pcc-status`), `ctx.session.hook("experimental.model.resolve" | "http.response" | "model.request")`, `ctx.storage` keys (`apple-fm.state`, `apple-fm.toast`, `apple-fm.pcc-status`, `apple-fm.diagnostic`), `Provider.ID` / `Model.ID` branded types. TUI plugin shape is `dist/tui/plugin` — `src/tui.ts` kept side-effect-free so headless loads don't need Solid.
- `FoundationModels` (macOS 26+): Swift-only, `linkerSettings: [.linkedFramework("FoundationModels")]`, `SystemLanguageModel.default.availability`, `LanguageModelSession(model: .default, tools, transcript)`, `Transcript.Entry`, `GenerationOptions`, `Tool` protocol, `LanguageModelSession.GenerationError` (mapped via `BridgeError.isRateLimit` heuristic).
- Swift dependency-free POSIX HTTP: `socket`/`bind`/`listen`/`accept` on `127.0.0.1`, manual header parsing, SSE writer; universal build via `lipo -create arm64 + x86_64` with `arch -x86_64` fallback.
- `@types/bun@^1.1.14` / `typescript@^5.7.3`: `tsconfig.json` ES2022 + Bundler + strict.
- Toolchain: Xcode CLI Tools (`/Library/Developer/CommandLineTools`, `macosx27.0` SDK), `codesign --force --sign $APPLE_FM_SIGN_IDENTITY --options runtime --timestamp`, optional `notarytool`/`stapler` via `APPLE_NOTARY_PROFILE`.
