import Foundation

// MARK: - Generic JSON value (OpenAI schemas are arbitrary JSON)

enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
}

// MARK: - Request

enum ChatContent: Decodable {
    case text(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            self = .text(s)
            return
        }
        if let parts = try? c.decode([ContentPart].self) {
            self = .text(parts.compactMap { $0.text }.joined(separator: "\n"))
            return
        }
        self = .text("")
    }

    private struct ContentPart: Decodable {
        let type: String?
        let text: String?
    }

    var text: String { if case .text(let t) = self { return t }; return "" }
}

struct ChatMessage: Decodable {
    let role: String
    let content: ChatContent?
    let tool_calls: [ToolCallSpec]?
    let tool_call_id: String?
    let name: String?

    var text: String { content?.text ?? "" }
}

struct FunctionCallSpec: Codable {
    let name: String
    let arguments: String
}

struct ToolCallSpec: Codable {
    let id: String
    var type: String = "function"
    let function: FunctionCallSpec
}

struct FunctionSpec: Decodable {
    let name: String
    let description: String?
    let parameters: JSONValue?
}

struct ToolSpec: Decodable {
    let type: String?
    let function: FunctionSpec
}

struct ChatRequest: Decodable {
    let model: String?
    let messages: [ChatMessage]
    let stream: Bool?
    let temperature: Double?
    let max_tokens: Int?
    let tools: [ToolSpec]?
    let conversation_id: String?
}

// MARK: - Response

struct UsageInfo: Encodable {
    let promptTokens: Int
    let completionTokens: Int
    let totalTokens: Int

    enum CodingKeys: String, CodingKey {
        case promptTokens = "prompt_tokens"
        case completionTokens = "completion_tokens"
        case totalTokens = "total_tokens"
    }
}

struct Choice: Encodable {
    let index: Int
    let message: AssistantMessage
    let finishReason: String

    enum CodingKeys: String, CodingKey {
        case index, message
        case finishReason = "finish_reason"
    }
}

struct AssistantMessage: Encodable {
    let role: String = "assistant"
    let content: String?
    let toolCalls: [ToolCallSpec]?

    enum CodingKeys: String, CodingKey {
        case role, content
        case toolCalls = "tool_calls"
    }
}

struct ChatCompletionResponse: Encodable {
    let id: String
    let object: String = "chat.completion"
    let created: Int
    let model: String
    let choices: [Choice]
    let usage: UsageInfo
}

struct DeltaMessage: Encodable {
    let role: String?
    let content: String?
    let toolCalls: [ToolCallSpec]?

    enum CodingKeys: String, CodingKey {
        case role, content
        case toolCalls = "tool_calls"
    }
}

struct StreamChoice: Encodable {
    let index: Int
    let delta: DeltaMessage
    let finishReason: String?

    enum CodingKeys: String, CodingKey {
        case index, delta
        case finishReason = "finish_reason"
    }
}

struct StreamChunk: Encodable {
    let id: String
    let object: String = "chat.completion.chunk"
    let created: Int
    let model: String
    let choices: [StreamChoice]
}

struct ErrorBody: Encodable {
    let error: ErrorDetail
    struct ErrorDetail: Encodable {
        let message: String
        let type: String
        let code: String?

        init(message: String, type: String = "invalid_request_error", code: String? = nil) {
            self.message = message
            self.type = type
            self.code = code
        }
    }
}

struct HealthBody: Encodable {
    let status: String
    let available: Bool
    let reason: String?
    let detail: String?
    let model: String
    let context: Int
    let computeTarget: String
    let pid: Int
    let pccState: String? // FR-2.4 / FR-3.3 transparency
    let pccResetAt: TimeInterval?

    enum CodingKeys: String, CodingKey {
        case status, available, reason, detail, model, context, pid
        case pccState = "pcc_state"
        case pccResetAt = "pcc_reset_at"
        case computeTarget = "compute_target"
    }
}

struct ModelList: Encodable {
    let object: String = "list"
    let data: [ModelEntry]
}

struct ModelEntry: Encodable {
    let id: String
    let object: String = "model"
    let ownedBy: String = "apple"
    let name: String
    let context: Int

    enum CodingKeys: String, CodingKey {
        case id, object, name, context
        case ownedBy = "owned_by"
    }
}
