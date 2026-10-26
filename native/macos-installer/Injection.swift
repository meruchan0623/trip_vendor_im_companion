import Foundation
import CryptoKit
import Darwin

// On-device adaptation of whichever compatible official client is installed. Mirrors
// scripts/lib/mac-pkg-asar.mjs, runtime/macho-fingerprint.ts and runtime/macos-page-compatibility.mjs.
let vendorExecutableName = "旅游商家桌面版"
let launcherName = "TripVendorLauncher"
let helperName = "旅游商家助手.app"
let bootstrapName = "trip-vendor-bootstrap.cjs"
let originalMainName = "companion-vendor-original-main.json"
let installedExecutable = "/Applications/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版"
let minimumVendorVersion = [1, 2, 11]
let imContract = ["chat-editor", "chat_area-input", "chat_area-button", "btn_send", "setContent", "chat_area-list", "chat_list_content", "normal-message-item", "customer_order-detail", "group-chat-hover-box", "chat-text", "preserveWhitespace"]
let navigationContract = ["menu-item-wrapper", "menu-text"]
let entryContract = ["requestSingleInstanceLock", "whenReady", "USER_DIST", "UNPACKED_DIST", "isUserPath"]

struct VendorInfo {
    var version: String, build: String, electron: String, chromiumMajor: Int
    var page: [String: String]
}
struct BuiltStage { var digest: String; var vendor: VendorInfo }

func versionParts(_ value: String) -> [Int]? {
    guard value.range(of: "^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,9}(\\.[0-9]{1,10})?$", options: .regularExpression) != nil else { return nil }
    return value.split(separator: ".").map { Int($0)! }
}
func supportedVendorVersion(_ value: String) -> Bool {
    guard let parts = versionParts(value) else { return false }
    return Array(parts.prefix(3)).lexicographicallyPrecedes(minimumVendorVersion) == false
}
func readPlist(_ url: URL) throws -> (value: [String: Any], format: PropertyListSerialization.PropertyListFormat) {
    var format = PropertyListSerialization.PropertyListFormat.xml
    guard let value = try PropertyListSerialization.propertyList(from: try readBounded(url, 4 * 1024 * 1024), options: [], format: &format) as? [String: Any] else { try fail("无法读取：\(url.path)") }
    return (value, format)
}
func writePlist(_ value: [String: Any], _ format: PropertyListSerialization.PropertyListFormat, _ url: URL) throws {
    try PropertyListSerialization.data(fromPropertyList: value, format: format, options: 0).write(to: url, options: .atomic)
}
func readBounded(_ url: URL, _ limit: Int) throws -> Data {
    var info = stat()
    guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= limit else { try fail("文件缺失、过大或不安全：\(url.lastPathComponent)") }
    return try Data(contentsOf: url)
}
func compactJSON(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
func matches(_ pattern: String, _ text: String, _ options: NSRegularExpression.Options = []) -> [NSTextCheckingResult] {
    (try? NSRegularExpression(pattern: pattern, options: options))?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? []
}

/// Fingerprint code and data independently of the embedded signature, which ad hoc re-signing replaces.
func unsignedMachOHash(_ url: URL) throws -> String {
    var data = try readBounded(url, 512 * 1024 * 1024)
    func u32(_ at: Int) -> Int { Int(data[at]) | Int(data[at + 1]) << 8 | Int(data[at + 2]) << 16 | Int(data[at + 3]) << 24 }
    func u64(_ at: Int) -> Int { u32(at) | u32(at + 4) << 32 }
    func put64(_ value: Int, _ at: Int) { for index in 0..<8 { data[at + index] = UInt8((value >> (8 * index)) & 0xff) } }
    guard data.count >= 32, u32(0) == 0xfeedfacf else { try fail("客户端主程序不是受支持的单架构 64 位 Mach-O") }
    let count = u32(16), end = 32 + u32(20)
    guard count <= 4096, end <= data.count else { try fail("客户端主程序格式无效") }
    var offset = 32, signatureOffset = 0, signatureSize = 0, linkedit = 0
    for _ in 0..<count {
        guard offset + 8 <= end else { try fail("客户端主程序格式无效") }
        let command = u32(offset), length = u32(offset + 4)
        guard length >= 8, offset + length <= end else { try fail("客户端主程序格式无效") }
        if command == 0x1d {
            guard length == 16, signatureOffset == 0 else { try fail("客户端主程序签名格式无效") }
            signatureOffset = u32(offset + 8); signatureSize = u32(offset + 12)
            for index in 8..<16 { data[offset + index] = 0 }
        }
        if command == 0x19, length >= 72, String(decoding: data[(offset + 8)..<(offset + 24)].prefix { $0 != 0 }, as: UTF8.self) == "__LINKEDIT" { linkedit = offset }
        offset += length
    }
    guard offset == end, signatureOffset != 0, signatureSize != 0, signatureOffset >= end, signatureOffset + signatureSize == data.count, linkedit != 0 else { try fail("客户端主程序签名格式无效") }
    let fileOffset = u64(linkedit + 40)
    guard fileOffset > end, fileOffset <= signatureOffset else { try fail("客户端主程序 __LINKEDIT 格式无效") }
    put64(0, linkedit + 32); put64(signatureOffset - fileOffset, linkedit + 48) // vmsize includes the variable-length signature.
    return sha(data.prefix(signatureOffset))
}

struct AsarPatch { var sha256: String; var headerSha256: String; var originalMain: String }
/// ASAR keeps the original packed bytes; only the header and three appended files change.
func patchVendorAsar(_ source: URL, _ destination: URL, bootstrap: Data) throws -> AsarPatch {
    let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
    let size = Int(try input.seekToEnd()); try input.seek(toOffset: 0)
    guard let prefix = try input.read(upToCount: 16), prefix.count == 16 else { try fail("客户端归档无效") }
    func u32(_ at: Int) -> Int { Int(prefix[at]) | Int(prefix[at + 1]) << 8 | Int(prefix[at + 2]) << 16 | Int(prefix[at + 3]) << 24 }
    let headerSize = u32(4), payloadSize = u32(8), stringSize = u32(12)
    guard u32(0) == 4, headerSize >= 8, headerSize <= 64 * 1024 * 1024, payloadSize + 4 == headerSize, stringSize <= payloadSize - 4, 8 + headerSize <= size,
          let headerText = try input.read(upToCount: stringSize), headerText.count == stringSize,
          var header = try JSONSerialization.jsonObject(with: headerText) as? [String: Any], var files = header["files"] as? [String: Any] else { try fail("客户端归档头无效") }
    let start = 8 + headerSize
    func packed(_ path: String, _ limit: Int) throws -> Data {
        var entry: Any? = header
        for part in path.split(separator: "/") { entry = ((entry as? [String: Any])?["files"] as? [String: Any])?[String(part)] }
        guard let file = entry as? [String: Any], (file["unpacked"] as? Bool) != true, file["link"] == nil, let offsetText = file["offset"] as? String,
              let offset = Int(offsetText), let length = (file["size"] as? NSNumber)?.intValue, length >= 0, length <= limit, start + offset + length <= size else { try fail("客户端归档中缺少可读文件：\(path)") }
        try input.seek(toOffset: UInt64(start + offset))
        guard let bytes = try input.read(upToCount: length), bytes.count == length else { try fail("客户端归档读取不完整：\(path)") }
        return bytes
    }
    guard var package = try JSONSerialization.jsonObject(with: try packed("package.json", 1024 * 1024)) as? [String: Any], let main = package["main"] as? String,
          !main.isEmpty, !main.hasPrefix("/"), !main.contains(":"), !main.split(whereSeparator: { $0 == "/" || $0 == "\\" }).contains(".."), (package["type"] as? String) != "module" else { try fail("客户端入口格式不受支持") }
    guard files[bootstrapName] == nil, files[originalMainName] == nil else { try fail("客户端入口已被修改过（可能已注入）。请先从官方 DMG 重新安装客户端。") }
    let entrySource = String(decoding: try packed(main, 32 * 1024 * 1024), as: UTF8.self)
    if let missing = entryContract.first(where: { !entrySource.contains($0) }) { try fail("客户端启动入口结构不兼容（缺少 \(missing)），暂不支持此版本") }
    package["main"] = bootstrapName
    var packageText = try JSONSerialization.data(withJSONObject: package, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]); packageText.append(0x0a)
    var mainText = try compactJSON(["main": main]); mainText.append(0x0a)
    let additions = [packageText, bootstrap, mainText]
    var offset = size - start
    for (index, name) in ["package.json", bootstrapName, originalMainName].enumerated() {
        let bytes = additions[index]
        let blocks = stride(from: 0, to: bytes.count, by: 4194304).map { sha(bytes.subdata(in: $0..<min($0 + 4194304, bytes.count))) }
        files[name] = ["size": bytes.count, "offset": String(offset), "integrity": ["algorithm": "SHA256", "hash": sha(bytes), "blockSize": 4194304, "blocks": blocks] as [String: Any]] as [String: Any]
        offset += bytes.count
    }
    header["files"] = files
    // Sorted keys keep rebuilds of the same client byte-identical; Electron does not depend on header order.
    let text = try compactJSON(header), padded = (text.count + 3) / 4 * 4
    var head = Data(count: 16 + padded)
    for (index, value) in [4, 8 + padded, 4 + padded, text.count].enumerated() { for byte in 0..<4 { head[index * 4 + byte] = UInt8((value >> (8 * byte)) & 0xff) } }
    head.replaceSubrange(16..<(16 + text.count), with: text)
    guard fm.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o644]) else { try fail("无法写入修补后的归档") }
    let output = try FileHandle(forWritingTo: destination); defer { try? output.close() }
    var digest = SHA256()
    func write(_ bytes: Data) throws { digest.update(data: bytes); try output.write(contentsOf: bytes) }
    try write(head); try input.seek(toOffset: UInt64(start))
    while let chunk = try input.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty { try write(chunk) }
    for bytes in additions { try write(bytes) }
    try output.synchronize()
    return AsarPatch(sha256: digest.finalize().map { String(format: "%02x", $0) }.joined(), headerSha256: sha(text), originalMain: main)
}

/// The two fixed HTML documents and their single relative module entrypoints, as the runtime probes them.
func probePages(_ dist: URL, packageVersion: String) throws -> [String: String] {
    guard let version = try JSONSerialization.jsonObject(with: try readBounded(dist.appendingPathComponent("packageVersion.json"), 16000)) as? [String: Any],
          let pkg = version["pkgVersion"] as? String, let ares = version["aresVersion"] as? String,
          ares.range(of: "^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,9}$", options: .regularExpression) != nil else { try fail("客户端页面版本信息无效") }
    guard pkg == packageVersion else { try fail("客户端页面包版本 \(pkg) 与客户端 \(packageVersion) 不一致") }
    var result = ["packageVersion": pkg, "aresVersion": ares]
    var scripts: [String] = []
    for (page, kind, limit, prefix) in [("imPlus", "imWindow", 8_000_000, ""), ("main", "mainWindow", 200_000, "navigation")] {
        let htmlBytes = try readBounded(dist.appendingPathComponent("src/pages/\(page)/index.html"), 20000)
        guard let html = String(data: htmlBytes, encoding: .utf8), matches("\\bid\\s*=\\s*[\"']root[\"']", html).count == 1 else { try fail("客户端页面结构不兼容：\(page)") }
        let modules = matches("<script\\b([^>]*)>", html, .caseInsensitive).map { (html as NSString).substring(with: $0.range(at: 1)) }.filter { !matches("\\btype\\s*=\\s*[\"']module[\"']", $0, .caseInsensitive).isEmpty }
        guard modules.count == 1 else { try fail("客户端页面结构不兼容：\(page)") }
        let sources = matches("\\bsrc\\s*=\\s*([\"'])([^\"']+)\\1", modules[0], .caseInsensitive).map { (modules[0] as NSString).substring(with: $0.range(at: 2)) }
        guard sources.count == 1, let name = matches("^\\.\\./\\.\\./\\.\\./js/(\(kind)-[A-Za-z0-9_-]{1,80}\\.js)$", sources[0]).first.map({ (sources[0] as NSString).substring(with: $0.range(at: 1)) }) else { try fail("客户端页面入口不兼容：\(page)") }
        let script = try readBounded(dist.appendingPathComponent("js/" + name), limit)
        scripts.append(String(decoding: script, as: UTF8.self))
        result[prefix.isEmpty ? "rendererName" : "navigationRendererName"] = name
        result[prefix.isEmpty ? "htmlSha256" : "navigationHtmlSha256"] = sha(htmlBytes)
        result[prefix.isEmpty ? "rendererSha256" : "navigationRendererSha256"] = sha(script)
    }
    if let missing = imContract.first(where: { !scripts[0].contains($0) }) ?? navigationContract.first(where: { !scripts[1].contains($0) }) { try fail("客户端页面功能结构不兼容（缺少 \(missing)），暂不支持此版本") }
    return result
}

final class InjectionBuilder {
    let components: URL
    var copy: (URL, URL) throws -> Void = { from, to in _ = try run("/usr/bin/ditto", ["--noqtn", from.path, to.path]) }
    var sign: (URL) throws -> Void = { app in
        _ = try run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app.path])
        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }
    init(components: URL) { self.components = components }

    /// Cheap checks shared by inspection and installation; the archive entry is checked while patching.
    func preflight(_ app: URL) throws -> VendorInfo {
        let info = try readPlist(app.appendingPathComponent("Contents/Info.plist")).value
        guard info["CFBundleIdentifier"] as? String == "com.ctrip.vbooking" else { try fail("所选应用不是旅游商家桌面版（Bundle ID 不符）") }
        guard let version = info["CFBundleShortVersionString"] as? String, let build = info["CFBundleVersion"] as? String,
              let parts = versionParts(version), parts.count == 3 else { try fail("无法读取客户端版本") }
        guard supportedVendorVersion(version) else { try fail("客户端版本 \(version) 过旧，助手需要 1.2.11 或更新的官方版本") }
        guard versionParts(build).map({ Array($0.prefix(3)) }) == parts else { try fail("客户端版本 \(version) 与构建号 \(build) 不一致，暂不支持") }
        guard info["CFBundleExecutable"] as? String == vendorExecutableName else { try fail("客户端主程序名称已变化，暂不支持此版本") }
        let framework = try readPlist(app.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Resources/Info.plist")).value
        guard let electron = framework["CFBundleVersion"] as? String, let major = versionParts(electron)?.first, major >= 27, major <= 400 else { try fail("客户端内置 Electron 版本过旧或无法识别（需要 27 或更新）") }
        // Electron 22 and later ship Chromium 2 * major + 64 (27 -> 118).
        return VendorInfo(version: version, build: build, electron: electron, chromiumMajor: major * 2 + 64,
                          page: try probePages(app.appendingPathComponent("Contents/Resources/app.asar.unpacked/dist"), packageVersion: version))
    }

    func verifyComponents(_ expected: String) throws {
        guard try treeDigest(components) == expected else { try fail("安装包组件校验失败，请重新获取安装器") }
        for name in [launcherName, helperName, bootstrapName] where !exists(components.appendingPathComponent(name)) { try fail("安装包缺少组件：\(name)") }
    }

    /// Copy the verified official source into the stage and adapt it there; the source is never modified.
    func build(from source: URL, into stage: URL, expected: String) throws -> BuiltStage {
        if exists(stage) { try fm.removeItem(at: stage) }
        try copy(source, stage)
        guard try treeDigest(stage) == expected else { try fail("复制官方客户端时文件发生变化，已停止") }
        let vendor = try preflight(stage)
        let contents = stage.appendingPathComponent("Contents"), resources = contents.appendingPathComponent("Resources")
        let executable = contents.appendingPathComponent("MacOS/" + vendorExecutableName), executableSha256 = try unsignedMachOHash(executable)
        let asar = resources.appendingPathComponent("app.asar"), patched = resources.appendingPathComponent("app.asar.tsim-patch")
        let patch = try patchVendorAsar(asar, patched, bootstrap: try readBounded(components.appendingPathComponent(bootstrapName), 1024 * 1024))
        try fm.removeItem(at: asar); try fm.moveItem(at: patched, to: asar)
        let plist = contents.appendingPathComponent("Info.plist")
        var (info, format) = try readPlist(plist)
        if let integrity = info["ElectronAsarIntegrity"] {
            guard var entries = integrity as? [String: Any], var entry = entries["Resources/app.asar"] as? [String: Any], entry["algorithm"] as? String == "SHA256" else { try fail("客户端归档完整性配置不受支持") }
            entry["hash"] = patch.headerSha256; entries["Resources/app.asar"] = entry; info["ElectronAsarIntegrity"] = entries
        }
        info["CFBundleExecutable"] = launcherName
        try writePlist(info, format, plist)
        let launcher = contents.appendingPathComponent("MacOS/" + launcherName)
        try copy(components.appendingPathComponent(launcherName), launcher)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher.path)
        let companion = resources.appendingPathComponent("companion")
        try fm.createDirectory(at: companion, withIntermediateDirectories: false)
        try copy(components.appendingPathComponent(helperName), companion.appendingPathComponent(helperName))
        guard let helperExecutable = try readPlist(companion.appendingPathComponent(helperName + "/Contents/Info.plist")).value["CFBundleExecutable"] as? String else { try fail("助手组件无效") }
        try compactJSON(["vendorExecutable": vendorExecutableName, "companionExecutable": helperExecutable]).write(to: companion.appendingPathComponent("launcher.json"))
        // Binds this installation for the helper; local hashes, not vendor signatures.
        let runtime: [String: Any] = ["schemaVersion": 1, "executable": installedExecutable, "executableVersion": vendor.build, "executableSha256": executableSha256,
                                      "asarSha256": patch.sha256, "chromiumMajor": vendor.chromiumMajor, "bundledPage": vendor.page]
        try compactJSON(runtime).write(to: companion.appendingPathComponent("vendor-runtime-manifest.json"))
        try sign(stage)
        guard try unsignedMachOHash(executable) == executableSha256, try fileDigest(asar) == patch.sha256 else { try fail("签名后客户端指纹发生变化") }
        return BuiltStage(digest: try treeDigest(stage), vendor: vendor)
    }
}
