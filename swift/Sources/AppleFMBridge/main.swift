import Foundation
import Darwin

@available(macOS 26.0, *)
func parseArgs() -> (token: String, port: UInt16, infoFile: String?, context: Int, maxOutput: Int) {
    let args = CommandLine.arguments
    var token = UUID().uuidString + UUID().uuidString
    var port: UInt16 = 0
    var infoFile: String?
    var context = 4096
    var maxOutput = 1024
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--token" where i + 1 < args.count: token = args[i + 1]; i += 2
        case "--port" where i + 1 < args.count: port = UInt16(args[i + 1]) ?? 0; i += 2
        case "--info-file" where i + 1 < args.count: infoFile = args[i + 1]; i += 2
        case "--context" where i + 1 < args.count: context = Int(args[i + 1]) ?? 4096; i += 2
        case "--max-output" where i + 1 < args.count: maxOutput = Int(args[i + 1]) ?? 1024; i += 2
        default: i += 1
        }
    }
    return (token, port, infoFile, context, maxOutput)
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

if #available(macOS 26.0, *) {
    let cfg = parseArgs()
    let server = HTTPServer(
        token: cfg.token,
        port: cfg.port,
        infoFile: cfg.infoFile,
        contextLimit: cfg.context,
        maxOutput: cfg.maxOutput
    )
    do {
        try server.run()
    } catch {
        FileHandle.standardError.write(Data("apple-fm-bridge: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
} else {
    FileHandle.standardError.write(Data("apple-fm-bridge requires macOS 26 or later.\n".utf8))
    exit(1)
}
