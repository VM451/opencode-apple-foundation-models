import Foundation
import Darwin

@available(macOS 26.0, *)
final class HTTPServer {
    private let token: String
    private let requestedPort: UInt16
    private let infoFile: String?
    private let runner: ModelRunner
    private let modelID = "system-language-model"
    private var listenFD: Int32 = -1
    private(set) var boundPort: UInt16 = 0

    init(token: String, port: UInt16, infoFile: String?, contextLimit: Int, maxOutput: Int) {
        self.token = token
        self.requestedPort = port
        self.infoFile = infoFile
        self.runner = ModelRunner(contextLimit: contextLimit, maxOutput: maxOutput)
    }

    func run() throws {
        listenFD = socket(AF_INET, Int32(SOCK_STREAM), 0)
        guard listenFD >= 0 else { throw BridgeError.badRequest("socket() failed") }
        var reuse: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = requestedPort.bigEndian

        let bindResult = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                Darwin.bind(listenFD, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { throw BridgeError.badRequest("bind() failed on 127.0.0.1:\(requestedPort)") }
        guard listen(listenFD, 32) == 0 else { throw BridgeError.badRequest("listen() failed") }

        var actual = addr
        var actualLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                getsockname(listenFD, sp, &actualLen)
            }
        }
        boundPort = UInt16(bigEndian: actual.sin_port)
        writeInfoFile()
        print("READY port=\(boundPort)")
        fflush(stdout)

        while true {
            var client = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let fd = withUnsafeMutablePointer(to: &client) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                    Darwin.accept(listenFD, sp, &clientLen)
                }
            }
            if fd < 0 { continue }
            let connectionFD = fd
            Task.detached { [weak self] in
                await self?.handle(fd: connectionFD)
            }
        }
    }

    private func writeInfoFile() {
        guard let infoFile else { return }
        let obj = ["port": Int(boundPort), "token": token] as [String: Any]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        let url = URL(fileURLWithPath: infoFile)
        try? data.write(to: url.appendingPathExtension("tmp"), options: .atomic)
        try? FileManager.default.removeItem(at: url)
        try? data.write(to: url, options: .atomic)
    }

    private func handle(fd: Int32) async {
        defer { close(fd) }
        do {
            let request = try readRequest(fd: fd)
            guard authorize(headers: request.headers) else {
                sendJSON(fd: fd, status: 401, body: ErrorBody(error: .init(message: "Invalid bearer token", type: "authentication_error", code: "unauthorized")))
                return
            }
            switch (request.method, request.path) {
            case ("GET", "/health"):
                let status = runner.checkAvailability()
                // FR-2.4 / FR-3.3 transparency: surface PCC state in health so the plugin can render countdown.
                // Swift is on-device only today; PCC fields let the TS state machine drive the UX while the bridge stays authoritative for availability.
                let health = HealthBody(
                    status: status.available ? "ok" : "unavailable",
                    available: status.available,
                    reason: status.code,
                    detail: status.message,
                    model: modelID,
                    context: runner.effectiveContextLimit(),
                    computeTarget: "on-device",
                    pid: Int(getpid()),
                    pccState: "on-device",
                    pccResetAt: nil
                )
                sendJSON(fd: fd, status: 200, body: health)
            case ("GET", "/v1/models"):
                let list = ModelList(data: [ModelEntry(
                    id: modelID, name: "Apple System Language Model (On-Device)",
                    context: runner.effectiveContextLimit()
                )])
                sendJSON(fd: fd, status: 200, body: list)
            case ("POST", "/v1/chat/completions"):
                await handleCompletion(fd: fd, body: request.body, headers: request.headers)
            default:
                sendJSON(fd: fd, status: 404, body: ErrorBody(error: .init(message: "Not found", type: "invalid_request_error", code: "not_found")))
            }
        } catch BridgeError.badRequest(let message) {
            sendJSON(fd: fd, status: 400, body: ErrorBody(error: .init(message: message, type: "invalid_request_error", code: "bad_request")))
        } catch {
            sendJSON(fd: fd, status: 500, body: ErrorBody(error: .init(message: "Bridge error: \(error.localizedDescription)", type: "server_error", code: "internal")))
        }
    }

    private func handleCompletion(fd: Int32, body: Data, headers: [String: String]) async {
        let decoder = JSONDecoder()
        guard let request = try? decoder.decode(ChatRequest.self, from: body) else {
            sendJSON(fd: fd, status: 400, body: ErrorBody(error: .init(message: "Malformed chat request", type: "invalid_request_error", code: "bad_request")))
            return
        }
        let kind = headers["x-opencode-kind"] ?? "primary"
        debugRequest(request, kind: kind)
        let streaming = request.stream ?? false
        // FR-2.4: every response carries X-Apple-Compute-Target (on-device today)
        let extra = ["X-Apple-Compute-Target": "on-device"]
        // Cache instructions for FR-2.3 - keyed by conversation_id when present
        if let conv = request.conversation_id, !conv.isEmpty {
            // Warm cache: if we have a system prompt, stash it to reuse next turn
            if let sys = request.messages.first(where: { $0.role == "system" })?.text, !sys.isEmpty {
                runner.cacheInstructions(conversationId: conv, instructions: sys)
            }
        }

        do {
            if streaming {
                let writer = SSEWriter(fd: fd, model: request.model ?? modelID)
                writer.writeHeaders(extra: extra)
                do {
                    let outcome = try await runner.generate(request: request, kind: kind) { delta in
                        writer.delta(delta)
                    }
                    if !outcome.toolCalls.isEmpty {
                        writer.toolCalls(outcome.toolCalls)
                    }
                    // HEADERS are only available before body; trimmed count is in final changelog already consumed.
                    // For non-streaming we expose X-Apple-FM-Context-Trimmed separately.
                    writer.done(trimmed: outcome.trimmedMessages)
                } catch BridgeError.rateLimited(_, let underlying) {
                    // Streaming already wrote headers — let TS layer retry on-device; just finish the stream
                    logError(underlying)
                    // Send rate-limit marker as SSE error tail (best-effort)
                    writer.fail()
                    // Note: Retry-After cannot be sent after SSE headers; TS state machine uses 429 on non-streaming path
                } catch {
                    logError(error)
                    writer.fail()
                }
                return
            } else {
                let outcome = try await runner.generate(request: request, kind: kind) { _ in }
                let message = AssistantMessage(
                    content: outcome.toolCalls.isEmpty ? outcome.text : nil,
                    toolCalls: outcome.toolCalls.isEmpty ? nil : outcome.toolCalls
                )
                let response = ChatCompletionResponse(
                    id: "chatcmpl-\(UUID().uuidString.prefix(12))",
                    created: Int(Date().timeIntervalSince1970),
                    model: request.model ?? modelID,
                    choices: [Choice(index: 0, message: message,
                        finishReason: outcome.toolCalls.isEmpty ? "stop" : "tool_calls")],
                    usage: UsageInfo(
                        promptTokens: outcome.promptTokens,
                        completionTokens: outcome.completionTokens,
                        totalTokens: outcome.promptTokens + outcome.completionTokens
                    )
                )
                var headers = extra
                headers["X-Apple-FM-Context-Trimmed"] = String(outcome.trimmedMessages)
                sendJSON(fd: fd, status: 200, body: response, extraHeaders: headers)
            }
        } catch BridgeError.unavailable(let status) {
            sendJSON(fd: fd, status: 503, body: ErrorBody(error: .init(message: status.message, type: "unavailable", code: status.code)), extraHeaders: extra)
        } catch BridgeError.rateLimited(let reset, let underlying) {
            // FR-3.1: return 429 + Retry-After so TS can compute cooldown + toast
            let retrySeconds: Int = {
                if let reset { return max(0, Int(reset.timeIntervalSinceNow)) }
                return 30 * 60
            }()
            var headers = extra
            headers["Retry-After"] = String(retrySeconds)
            headers["X-Apple-Compute-Target"] = "on-device" // after failover, we are on-device
            headers["X-Apple-PCC-State"] = "rate_limited"
            // Also include reset_at in body for parity with parseRetryAfter
            let body = ErrorBody(error: .init(
                message: "PCC usage limit: \(underlying.localizedDescription). Switched to on-device. Resets in \(retrySeconds)s.",
                type: "rate_limit_error",
                code: "pcc_rate_limited"
            ))
            // Attach reset_at in JSON? ErrorBody is OpenAI shape; we encode reset in message.
            // For machine parsing, Retry-After header is primary.
            sendJSON(fd: fd, status: 429, body: body, extraHeaders: headers)
            logError(underlying)
        } catch {
            logError(error)
            sendJSON(fd: fd, status: 500, body: ErrorBody(error: .init(message: "Generation failed: \(error.localizedDescription)", type: "server_error", code: "generation_failed")), extraHeaders: extra)
        }
    }

    private func logError(_ error: Error) {
        guard ProcessInfo.processInfo.environment["APPLE_FM_BRIDGE_DEBUG"] == "1" else { return }
        FileHandle.standardError.write(Data("apple-fm-bridge error: \(error.localizedDescription)\n".utf8))
    }

    /// Logs request metadata only - never prompt contents (NFR-2).
    private func debugRequest(_ request: ChatRequest, kind: String) {
        guard ProcessInfo.processInfo.environment["APPLE_FM_BRIDGE_DEBUG"] == "1" else { return }
        let roles = request.messages.map { $0.role }.joined(separator: ",")
        let chars = request.messages.reduce(0) { $0 + $1.text.utf8.count }
        let tools = request.tools?.map { $0.function.name }.joined(separator: ",") ?? "-"
        let line = "apple-fm-bridge req kind=\(kind) roles=\(roles) chars=\(chars) tools=\(tools) stream=\(request.stream ?? false) max=\(request.max_tokens ?? -1)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    private func authorize(headers: [String: String]) -> Bool {
        guard let auth = headers["authorization"] ?? headers["Authorization"] else { return false }
        return auth == "Bearer \(token)"
    }

    // MARK: - HTTP/1.1 parsing

    private struct RawRequest {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private func readRequest(fd: Int32) throws -> RawRequest {
        let marker = Data("\r\n\r\n".utf8)
        let head = try readUntil(fd: fd, marker: marker, maxBytes: 64 * 1024)
        guard let markerRange = head.range(of: marker) else { throw BridgeError.badRequest("Incomplete HTTP headers") }
        let headerData = head[head.startIndex..<markerRange.lowerBound]
        let headerString = String(data: headerData, encoding: .utf8) ?? ""
        let lines = headerString.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let first = lines.first else { throw BridgeError.badRequest("Empty request") }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { throw BridgeError.badRequest("Malformed request line") }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[line.startIndex..<colon]).lowercased()
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        var body = Data(head[markerRange.upperBound...])
        let contentLength = Int(headers["content-length"] ?? "") ?? 0
        while body.count < contentLength {
            let n = try readMore(fd: fd, into: &body)
            if n == 0 { break }
        }
        if contentLength > 0 && body.count > contentLength {
            body = body.prefix(contentLength)
        }
        return RawRequest(method: String(parts[0]), path: String(parts[1]), headers: headers, body: body)
    }

    private func readUntil(fd: Int32, marker: Data, maxBytes: Int) throws -> Data {
        var data = Data()
        while data.count < maxBytes {
            if data.range(of: marker) != nil { break }
            _ = try readMore(fd: fd, into: &data)
        }
        return data
    }

    private func readMore(fd: Int32, into data: inout Data) throws -> Int {
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        let n = chunk.withUnsafeMutableBytes { buf in
            Darwin.read(fd, buf.baseAddress, buf.count)
        }
        if n == 0 { return 0 }
        if n < 0 {
            if errno == EINTR { return 1 }
            throw BridgeError.badRequest("socket read failed")
        }
        data.append(contentsOf: chunk[0..<n])
        return n
    }

    // MARK: - Writing

    private func sendJSON(fd: Int32, status: Int, body: Encodable, extraHeaders: [String: String] = [:]) {
        let data = (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 401: reason = "Unauthorized"
        case 503: reason = "Service Unavailable"
        case 429: reason = "Too Many Requests"
        default: reason = "Error"
        }
        var header = "HTTP/1.1 \(status) \(reason)\r\n"
        header += "Content-Type: application/json; charset=utf-8\r\n"
        header += "Content-Length: \(data.count)\r\n"
        header += "Connection: close\r\n"
        for (k, v) in extraHeaders { header += "\(k): \(v)\r\n" }
        if !extraHeaders.keys.contains(where: { $0.lowercased() == "x-apple-compute-target" }) {
            header += "X-Apple-Compute-Target: on-device\r\n"
        }
        header += "\r\n"
        try? writeAll(fd: fd, Data(header.utf8))
        try? writeAll(fd: fd, data)
    }

    private func writeAll(fd: Int32, _ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeBytes { buf in
                Darwin.write(fd, buf.baseAddress!.advanced(by: offset), data.count - offset)
            }
            if n == 0 { return }
            if n < 0 {
                if errno == EINTR { continue }
                throw BridgeError.badRequest("socket write failed")
            }
            offset += n
        }
    }
}

@available(macOS 26.0, *)
final class SSEWriter {
    let fd: Int32
    let id: String
    let created: Int
    let model: String
    private(set) var failed = false
    private var started = false

    init(fd: Int32, model: String) {
        self.fd = fd
        self.id = "chatcmpl-\(UUID().uuidString.prefix(12))"
        self.created = Int(Date().timeIntervalSince1970)
        self.model = model
    }

    func writeHeaders(extra: [String: String]) {
        var header = "HTTP/1.1 200 OK\r\n"
        header += "Content-Type: text/event-stream; charset=utf-8\r\n"
        header += "Cache-Control: no-cache\r\n"
        header += "Connection: close\r\n"
        for (k, v) in extra { header += "\(k): \(v)\r\n" }
        header += "\r\n"
        try? writeAll(fd: fd, Data(header.utf8))
        started = true
    }

    func delta(_ text: String) {
        guard started else { return }
        send(StreamChunk(
            id: id, created: created, model: model,
            choices: [StreamChoice(index: 0, delta: DeltaMessage(role: nil, content: text, toolCalls: nil), finishReason: nil)]
        ))
    }

    func toolCalls(_ calls: [ToolCallSpec]) {
        guard started else { return }
        send(StreamChunk(
            id: id, created: created, model: model,
            choices: [StreamChoice(index: 0, delta: DeltaMessage(role: nil, content: nil, toolCalls: calls), finishReason: "tool_calls")]
        ))
    }

    func done(trimmed: Int) {
        guard started else { return }
        send(StreamChunk(
            id: id, created: created, model: model,
            choices: [StreamChoice(index: 0, delta: DeltaMessage(role: nil, content: nil, toolCalls: nil), finishReason: "stop")]
        ))
        try? writeAll(fd: fd, Data("data: [DONE]\n\n".utf8))
    }

    /// Closes a stream that was already opened when generation fails. A second
    /// HTTP response here would corrupt the SSE body for OpenAI-compatible clients.
    func fail() {
        done(trimmed: 0)
    }

    private func send(_ chunk: StreamChunk) {
        guard let data = try? JSONEncoder().encode(chunk),
              let line = String(data: data, encoding: .utf8) else { return }
        do { try writeAll(fd: fd, Data("data: \(line)\n\n".utf8)) }
        catch { failed = true }
    }

    private func writeAll(fd: Int32, _ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeBytes { buf in
                Darwin.write(fd, buf.baseAddress!.advanced(by: offset), data.count - offset)
            }
            if n == 0 { return }
            if n < 0 {
                if errno == EINTR { continue }
                throw BridgeError.badRequest("write failed")
            }
            offset += n
        }
    }
}
