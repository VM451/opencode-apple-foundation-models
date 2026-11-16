import Foundation
import FoundationModels

@available(macOS 26.0, *)
enum SchemaConverter {
    /// Converts a (flat) OpenAI JSON Schema into an Apple GenerationSchema.
    /// Nested objects/arrays of objects are intentionally flattened to strings:
    /// the ~3B on-device model is unreliable with deep schemas (PRD risk mitigation).
    static func convert(name: String, description: String?, json: JSONValue?) -> GenerationSchema {
        let obj = json?.objectValue ?? [:]
        let properties = obj["properties"]?.objectValue ?? [:]
        let required = Set(obj["required"]?.arrayValue?.compactMap { $0.stringValue } ?? [])

        var props: [GenerationSchema.Property] = []
        // Keep schemas flat and small: the on-device model has a 4096-token
        // budget and OpenCode can send a dozen tools with verbose schemas.
        for (key, value) in properties.sorted(by: { $0.key < $1.key }).prefix(4) {
            let dict = value.objectValue ?? [:]
            let desc = dict["description"]?.stringValue.map { String($0.prefix(100)) }
            let typeName = dict["type"]?.stringValue ?? "string"
            if let p = property(name: key, description: desc, typeName: typeName, required: required.contains(key)) {
                props.append(p)
            }
        }
        let shortDescription = description.map { String($0.prefix(160)) }
        return GenerationSchema(type: GeneratedContent.self, description: shortDescription, properties: props)
    }

    private static func property(name: String, description: String?, typeName: String, required: Bool) -> GenerationSchema.Property? {
        switch typeName {
        case "string":
            return required
                ? GenerationSchema.Property(name: name, description: description, type: String.self)
                : GenerationSchema.Property(name: name, description: description, type: String?.self)
        case "integer":
            return required
                ? GenerationSchema.Property(name: name, description: description, type: Int.self)
                : GenerationSchema.Property(name: name, description: description, type: Int?.self)
        case "number":
            return required
                ? GenerationSchema.Property(name: name, description: description, type: Double.self)
                : GenerationSchema.Property(name: name, description: description, type: Double?.self)
        case "boolean":
            return required
                ? GenerationSchema.Property(name: name, description: description, type: Bool.self)
                : GenerationSchema.Property(name: name, description: description, type: Bool?.self)
        case "array":
            return required
                ? GenerationSchema.Property(name: name, description: description, type: [String].self)
                : GenerationSchema.Property(name: name, description: description, type: [String]?.self)
        default:
            return required
                ? GenerationSchema.Property(name: name, description: description, type: String.self)
                : GenerationSchema.Property(name: name, description: description, type: String?.self)
        }
    }
}

/// Thrown from a tool's `call` to stop the model's tool loop. The recorded
/// call is returned to OpenCode, which executes the real tool and sends the
/// result back in a follow-up request.
enum ToolAbort: Error { case recorded }

@available(macOS 26.0, *)
final class ToolCallCollector: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [(name: String, arguments: String)] = []

    func record(name: String, arguments: String) {
        lock.lock()
        calls.append((name, arguments))
        lock.unlock()
    }

    var snapshot: [(name: String, arguments: String)] {
        lock.lock(); defer { lock.unlock() }
        return calls
    }
}

@available(macOS 26.0, *)
struct DynamicTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let collector: ToolCallCollector
    let includesSchemaInInstructions: Bool = true

    func call(arguments: GeneratedContent) async throws -> String {
        collector.record(name: name, arguments: arguments.jsonString)
        throw ToolAbort.recorded
    }
}
