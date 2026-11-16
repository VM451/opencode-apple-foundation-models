import Foundation
import FoundationModels

@available(macOS 26.0, *)
struct AvailabilityStatus {
    let available: Bool
    let code: String
    let message: String
}

@available(macOS 26.0, *)
struct GenerationOutcome {
    var text: String = ""
    var toolCalls: [ToolCallSpec] = []
    var promptTokens: Int = 0
    var completionTokens: Int = 0
    var trimmedMessages: Int = 0
}

@available(macOS 26.0, *)
struct ModelRunner {
    let contextLimit: Int
    let maxOutput: Int

    func checkAvailability() -> AvailabilityStatus {
        switch SystemLanguageModel.default.availability {
        case .available:
            return AvailabilityStatus(available: true, code: "available", message: "On-device Foundation Model is ready.")
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible:
                return AvailabilityStatus(available: false, code: "device_not_eligible",
                    message: "Requires an Apple Silicon Mac running macOS 26+ with Apple Intelligence support.")
            case .appleIntelligenceNotEnabled:
                return AvailabilityStatus(available: false, code: "apple_intelligence_disabled",
                    message: "Enable Apple Intelligence in System Settings > Apple Intelligence & Siri, then reopen OpenCode.")
            case .modelNotReady:
                return AvailabilityStatus(available: false, code: "model_not_ready",
                    message: "Foundation Model assets are still downloading. Check System Settings > Apple Intelligence & Siri.")
            @unknown default:
                return AvailabilityStatus(available: false, code: "unavailable",
                    message: "Foundation Model is unavailable on this device.")
            }
        }
    }

    func effectiveContextLimit() -> Int {
        min(contextLimit, SystemLanguageModel.default.contextSize)
    }

    // FR-2.3: Lightweight session cache keyed by conversation_id.
    // Avoids re-evaluating static system prompts on every turn within the same OpenCode session.
    // Bounded LRU (32 entries, 5 min TTL) to keep bridge RSS <30MB idle.
    private static let sessionCache: SessionCache = SessionCache(maxEntries: 32, ttl: 5 * 60)

    /// Returns cached instructions for this conversation if present, else nil.
    func cachedInstructions(conversationId: String?) -> String? {
        guard let id = conversationId, !id.isEmpty else { return nil }
        return Self.sessionCache.get(key: id)
    }

    func cacheInstructions(conversationId: String?, instructions: String) {
        guard let id = conversationId, !id.isEmpty else { return }
        Self.sessionCache.put(key: id, value: instructions)
    }

    func generate(request: ChatRequest, kind: String = "primary", onDelta: @escaping (String) -> Void) async throws -> GenerationOutcome {
        let status = checkAvailability()
        guard status.available else { throw BridgeError.unavailable(status) }

        let isCompaction = kind == "compaction"
        let limit = effectiveContextLimit()
        let outputCap = min(request.max_tokens ?? maxOutput, maxOutput)
        let reserve = outputCap + 256
        let toolEstimate = isCompaction ? 0 : (request.tools?.count ?? 0) * 250

        let lastIsTool = request.messages.last?.role == "tool"
        var instructions = request.messages.filter { $0.role == "system" }.map(\.text).joined(separator: "\n\n")
        if isCompaction {
            instructions = "Summarize the conversation faithfully and concisely. Output only the summary."
        } else if instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            instructions = "You are a concise coding assistant running entirely on-device."
        }

        // The system prompt can be tens of thousands of tokens in OpenCode. The
        // on-device model only has ~4096, so cap instructions before budgeting turns.
        let directive = "Follow the user's latest instruction exactly. Call a tool only when the user explicitly asks for a file or system action."
        instructions = (lastIsTool ? "Answer the user now using the tool result. Do not call tools." : directive) + "\n\n" + instructions
        let instructionCap = max(256, limit - reserve - toolEstimate - 512)
        if estimateTokens(instructions) > instructionCap {
            instructions = String(instructions.prefix(instructionCap * 3)) + "\n[truncated]"
        }
        let budget = max(256, limit - reserve - toolEstimate - estimateTokens(instructions))

        var prompt = lastIsTool
            ? "Using the tool result above, give the final answer to the user now. Do not call tools."
            : (request.messages.last?.text ?? "")
        let promptCap = max(256, budget - 256)
        if estimateTokens(prompt) > promptCap {
            // OpenCode appends the real user message at the end of a large context
            // block, so keep the tail, not the head.
            prompt = "[earlier context truncated]\n" + String(prompt.suffix(promptCap * 3))
        }
        var history = lastIsTool ? request.messages : Array(request.messages.dropLast())
        history = history.filter { $0.role != "system" }

        // Context guardrail: slide the window before hitting the model's hard limit.
        var trimmed = 0
        while estimateTokens(history) + estimateTokens([ChatMessage(role: "user", content: .text(prompt), tool_calls: nil, tool_call_id: nil, name: nil)]) > budget,
              history.count > 2 {
            history.removeFirst()
            trimmed += 1
        }
        if estimateTokens(history) + estimateTokens(prompt) > budget {
            history = Array(history.suffix(2))
            trimmed += 1
        }

        var toolNames: [String: String] = [:]
        for m in history where m.role == "assistant" {
            for call in m.tool_calls ?? [] { toolNames[call.id] = call.function.name }
        }

        var entries: [Transcript.Entry] = [
            .instructions(Transcript.Instructions(
                segments: [.text(Transcript.TextSegment(content: instructions))],
                toolDefinitions: []
            ))
        ]

        for m in history {
            switch m.role {
            case "user":
                entries.append(.prompt(Transcript.Prompt(segments: [
                    .text(Transcript.TextSegment(content: m.text))
                ])))
            case "assistant":
                if let calls = m.tool_calls, !calls.isEmpty {
                    var native: [Transcript.ToolCall] = []
                    for c in calls {
                        let args: GeneratedContent
                        if let gc = try? GeneratedContent(json: c.function.arguments) {
                            args = gc
                        } else {
                            args = GeneratedContent(c.function.arguments)
                        }
                        native.append(Transcript.ToolCall(id: c.id, toolName: c.function.name, arguments: args))
                        toolNames[c.id] = c.function.name
                    }
                    entries.append(.toolCalls(Transcript.ToolCalls(native)))
                } else if !m.text.isEmpty {
                    entries.append(.response(Transcript.Response(
                        id: UUID().uuidString,
                        assetIDs: [],
                        segments: [.text(Transcript.TextSegment(content: m.text))]
                    )))
                }
            case "tool":
                let id = m.tool_call_id ?? UUID().uuidString
                entries.append(.toolOutput(Transcript.ToolOutput(
                    id: id,
                    toolName: toolNames[id] ?? m.name ?? "tool",
                    segments: [.text(Transcript.TextSegment(content: m.text))]
                )))
            default:
                break
            }
        }

        let collector = ToolCallCollector()
        let tools: [any Tool] = (isCompaction || lastIsTool ? [] : (request.tools ?? [])).compactMap { spec in
            guard spec.type == nil || spec.type == "function" else { return nil }
            return DynamicTool(
                name: spec.function.name,
                description: String((spec.function.description ?? spec.function.name).prefix(160)),
                parameters: SchemaConverter.convert(
                    name: spec.function.name,
                    description: spec.function.description,
                    json: spec.function.parameters
                ),
                collector: collector
            )
        }

        let session = LanguageModelSession(
            model: .default,
            tools: tools,
            transcript: Transcript(entries: entries)
        )

        var options = GenerationOptions(
            temperature: request.temperature,
            maximumResponseTokens: outputCap
        )
        #if compiler(>=5.3)
        if #available(macOS 27.0, *) { options.toolCallingMode = .allowed }
        #endif

        var outcome = GenerationOutcome()
        outcome.trimmedMessages = trimmed
        var emitted = 0

        do {
            let stream = session.streamResponse(to: prompt, options: options)
            for try await snapshot in stream {
                let text = snapshot.content
                if text.count > emitted {
                    let delta = String(text.dropFirst(emitted))
                    emitted = text.count
                    outcome.text = text
                    onDelta(delta)
                }
            }
        } catch {
            let recorded = collector.snapshot
            if !recorded.isEmpty {
                // tool call recorded before error — treat as success path below
            } else if BridgeError.isRateLimit(error) {
                throw BridgeError.rateLimited(resetAt: BridgeError.retryAfterReset(from: error), underlying: error)
            } else {
                throw error
            }
        }

        let recorded = collector.snapshot
        if !recorded.isEmpty {
            outcome.toolCalls = recorded.enumerated().map { idx, call in
                ToolCallSpec(
                    id: "call_\(UUID().uuidString.prefix(8))_\(idx)",
                    type: "function",
                    function: FunctionCallSpec(name: call.name, arguments: call.arguments)
                )
            }
            outcome.text = ""
            onDelta("")
        }

        #if compiler(>=5.3)
        if #available(macOS 27.0, *) {
            outcome.promptTokens = session.usage.input.totalTokenCount
            outcome.completionTokens = session.usage.output.totalTokenCount
        } else {
            outcome.promptTokens = estimateTokens(history) + estimateTokens(prompt)
            outcome.completionTokens = estimateTokens(outcome.text)
        }
        #else
        outcome.promptTokens = estimateTokens(history) + estimateTokens(prompt)
        outcome.completionTokens = estimateTokens(outcome.text)
        #endif
        return outcome
    }

    private func estimateTokens(_ messages: [ChatMessage]) -> Int {
        messages.reduce(0) { $0 + estimateTokens($1.text) + 4 }
    }

    private func estimateTokens(_ text: String) -> Int {
        max(1, text.utf8.count / 3)
    }
}

enum BridgeError: Error, LocalizedError {
    case unavailable(AvailabilityStatus)
    case badRequest(String)
    case rateLimited(resetAt: Date?, underlying: Error)

    var errorDescription: String? {
        switch self {
        case .unavailable(let s): return s.message
        case .badRequest(let m): return m
        case .rateLimited(let reset, let err):
            if let reset {
                let fmt = ISO8601DateFormatter()
                return "PCC rate limit: \(err.localizedDescription) resets at \(fmt.string(from: reset))"
            }
            return "PCC rate limit: \(err.localizedDescription)"
        }
    }

    /// Heuristic extractor for PCC / rate-limit signals (FR-3.1).
    /// Apple may surface LanguageModelSession.GenerationError.rateLimited or
    /// OS throttling via NSError localizedDescription / underlying userInfo.
    static func isRateLimit(_ error: Error) -> Bool {
        // Error string can be "rate limited", "quota", "usage limit", "throttled"
        let text = error.localizedDescription.lowercased()
        if text.contains("rate") || text.contains("quota") || text.contains("throttl") || text.contains("usage limit") || text.contains("pcc") {
            return true
        }
        // NSError domain check for PCC
        if let nsErr = error as NSError? {
            let code = nsErr.domain.lowercased() + " " + String(nsErr.code)
            if code.contains("rate") || code.contains("quota") || code.contains("pcc") { return true }
            if let info = nsErr.userInfo["NSUnderlyingError"] as? NSError {
                return isRateLimit(info)
            }
            if let retry = nsErr.userInfo["Retry-After"] ?? nsErr.userInfo["retry-after"] ?? nsErr.userInfo["reset_at"] ?? nsErr.userInfo["resetAt"] {
                _ = retry
                return true
            }
        }
        // Mirror check via mirror forGenerationError enum
        let mirror = String(describing: error).lowercased()
        if mirror.contains("ratelimited") || mirror.contains("rate_limited") || mirror.contains("generationerror") {
            // Conservative: only if localized describes rate/quota
            return text.contains("rate") || mirror.contains("rate")
        }
        return false
    }

    static func retryAfterReset(from error: Error, defaultCooldownMinutes: Int = 30) -> Date {
        if let nsErr = error as NSError? {
            if let v = nsErr.userInfo["Retry-After"] ?? nsErr.userInfo["retry-after"] {
                if let num = v as? NSNumber, num.doubleValue > 0 { return Date().addingTimeInterval(num.doubleValue) }
                if let s = v as? String, let num = Double(s) { return Date().addingTimeInterval(num) }
            }
            for k in ["reset_at", "resetAt", "expires_at", "expiresAt", "reset"] {
                if let v = nsErr.userInfo[k] {
                    if let date = v as? Date { return date }
                    if let num = v as? NSNumber { let d = num.doubleValue; return Date(timeIntervalSince1970: d > 1e12 ? d/1000 : d) }
                    if let s = v as? String {
                        if let num = Double(s) { return Date(timeIntervalSince1970: num > 1e12 ? num/1000 : num) }
                        if let iso = ISO8601DateFormatter().date(from: s) { return iso }
                    }
                }
            }
        }
        // Fallback default cooldown (FR-3.1)
        return Date().addingTimeInterval(TimeInterval(defaultCooldownMinutes * 60))
    }
}
