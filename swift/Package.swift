// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AppleFMBridge",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "apple-fm-bridge", targets: ["AppleFMBridge"])
    ],
    targets: [
        .executableTarget(
            name: "AppleFMBridge",
            path: "Sources/AppleFMBridge",
            linkerSettings: [.linkedFramework("FoundationModels")]
        )
    ],
    swiftLanguageModes: [.v5]
)
