// swift-tools-version:5.9
// The orb's island, drawn natively: built and linked into the app by
// swift-rs's SwiftLinker from build.rs.
import PackageDescription

let package = Package(
    name: "Island",
    platforms: [.macOS(.v13)],
    products: [.library(name: "Island", type: .static, targets: ["Island"])],
    targets: [.target(name: "Island")]
)
