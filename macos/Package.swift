// swift-tools-version:5.9
// Kaito para macOS. KaitoCore (solo Foundation, compila también en Linux) + KaitoApp (SwiftUI/AppKit, solo macOS).
import PackageDescription

var targets: [Target] = [
    .target(name: "KaitoCore", path: "Sources/KaitoCore"),
    .testTarget(name: "KaitoCoreTests", dependencies: ["KaitoCore"], path: "Tests/KaitoCoreTests"),
]
var products: [Product] = [
    .library(name: "KaitoCore", targets: ["KaitoCore"]),
]

#if os(macOS)
targets.append(.executableTarget(
    name: "KaitoApp",
    dependencies: ["KaitoCore"],
    path: "Sources/KaitoApp",
    linkerSettings: [
        .linkedFramework("Carbon"),
        .linkedFramework("ServiceManagement"),
        .linkedFramework("Security"),
        .linkedFramework("UserNotifications"),
    ]
))
products.append(.executable(name: "KaitoApp", targets: ["KaitoApp"]))
#endif

let package = Package(
    name: "Kaito",
    platforms: [.macOS(.v14)],
    products: products,
    targets: targets
)
