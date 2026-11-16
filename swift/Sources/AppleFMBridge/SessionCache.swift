import Foundation

/// Bounded LRU for FR-2.3 session caching (conversation_id → cached instructions).
/// Avoids re-evaluating static system prompts on every turn within the same session.
/// Keeps bridge idle RSS <30MB (NFR-4).
@available(macOS 26.0, *)
final class SessionCache: @unchecked Sendable {
    private let maxEntries: Int
    private let ttl: TimeInterval
    private let lock = NSLock()
    private var store: [String: (value: String, at: Date)] = [:]
    private var order: [String] = []

    init(maxEntries: Int = 32, ttl: TimeInterval = 300) {
        self.maxEntries = maxEntries
        self.ttl = ttl
    }

    func get(key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = store[key] else { return nil }
        if Date().timeIntervalSince(entry.at) > ttl {
            store.removeValue(forKey: key)
            order.removeAll { $0 == key }
            return nil
        }
        // touch LRU
        order.removeAll { $0 == key }
        order.append(key)
        return entry.value
    }

    func put(key: String, value: String) {
        lock.lock()
        defer { lock.unlock() }
        store[key] = (value, Date())
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > maxEntries {
            let evict = order.removeFirst()
            store.removeValue(forKey: evict)
        }
        // clamp value length to avoid unbounded memory (keep only head, we truncate later anyway)
        if value.utf8.count > 16_384 {
            store[key] = (String(value.prefix(4096 * 3)), Date())
        }
    }
}
