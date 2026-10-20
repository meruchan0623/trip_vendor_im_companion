import Foundation
import CryptoKit
import Darwin

enum InstallFailure: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let text): return text } }
}
func fail(_ text: String) throws -> Never { throw InstallFailure.message(text) }
let injectorKind = "trip-vendor-macos-injector-v1"
let officialRequirement = "=anchor apple generic and identifier \"com.ctrip.vbooking\" and certificate leaf[subject.OU] = \"RPQ7NNQCK8\""
let fm = FileManager.default
func run(_ path: String, _ args: [String]) throws -> String {
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: path); process.arguments = args
    process.standardOutput = output; process.standardError = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    guard process.terminationStatus == 0 else { try fail("命令失败：\(path)\n\(text)") }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func exists(_ url: URL) -> Bool { var info = stat(); return lstat(url.path, &info) == 0 }
func secureDirectory(_ url: URL) throws {
    var info = stat()
    guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
          url.standardizedFileURL.path == url.resolvingSymlinksInPath().path else { try fail("目录路径不安全：\(url.path)") }
}
// Canonical tree digest shared with scripts/lib/mac-installer-package.mjs.
// Extended attributes are deliberately excluded; signatures and every bundle file are included.
func treeDigest(_ root: URL) throws -> String {
    var hash = SHA256()
    func add(_ text: String) { hash.update(data: Data(text.utf8)) }
    func visit(_ folder: URL, _ prefix: String) throws {
        let names = try fm.contentsOfDirectory(atPath: folder.path).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
        for name in names {
            let file = folder.appendingPathComponent(name), relative = prefix + name
            var info = stat(); guard lstat(file.path, &info) == 0 else { try fail("无法读取：\(file.path)") }
            switch info.st_mode & S_IFMT {
            case S_IFLNK: add("L\0\(relative)\0\(try fm.destinationOfSymbolicLink(atPath: file.path))\0")
            case S_IFDIR: add("D\0\(relative)\0"); try visit(file, relative + "/")
            case S_IFREG:
                add("F\0\(relative)\0\(info.st_mode & 0o777)\0")
                let handle = try FileHandle(forReadingFrom: file)
                defer { try? handle.close() }
                while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
            default: try fail("应用中存在不支持的文件：\(relative)")
            }
        }
    }
    try secureDirectory(root); try visit(root, "")
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
struct InjectorManifest: Codable {
    var kind: String
    var version: String
    var architecture: String
    var bundleId: String
    var vendorVersion: String
    var officialSha256: String
    var payloadSha256: String
}
struct Receipt: Codable {
    var kind: String = injectorKind
    var target: String
    var originalSha256: String
    var installedSha256: String
    var version: String
    var state: String
    var hadInstalled: Bool
}
struct Inspection: Codable {
    var state: String
    var message: String
    var version: String
    var target: String
    var canInstall: Bool
    var canRestore: Bool
}
func readJSON<T: Decodable>(_ type: T.Type, _ url: URL) throws -> T {
    var info = stat()
    guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { try fail("文件不存在或不安全：\(url.path)") }
    return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}
func atomicJSON<T: Encodable>(_ value: T, _ url: URL) throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(value).write(to: url, options: .atomic)
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW); guard fd >= 0 else { try fail("无法同步安装收据") }
    defer { close(fd) }; guard fsync(fd) == 0 else { try fail("无法同步安装收据") }
    try syncDirectory(url.deletingLastPathComponent())
}
func syncDirectory(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else { try fail("无法同步目录：\(url.path)") }; defer { close(fd) }
    guard fsync(fd) == 0 else { try fail("无法同步目录：\(url.path)") }
}

final class InjectorEngine {
    let manifest: InjectorManifest, payload: URL, target: URL, store: URL
    let verifyOfficial: (URL) throws -> Void, verifyPayload: (URL) throws -> Void
    let assertIdle: () throws -> Void, copy: (URL, URL) throws -> Void
    var log: (String) -> Void = { print($0) }
    var receiptURL: URL { store.appendingPathComponent("receipt.json") }
    var pendingURL: URL { store.appendingPathComponent("pending.json") }
    var backup: URL { store.appendingPathComponent("official.app") }
    var stage: URL { store.appendingPathComponent("stage.app") }
    var previous: URL { store.appendingPathComponent("previous.app") }

    init(manifest: InjectorManifest, payload: URL, target: URL,
         verifyOfficial: ((URL) throws -> Void)? = nil,
         verifyPayload: ((URL) throws -> Void)? = nil,
         assertIdle: (() throws -> Void)? = nil,
         copy: ((URL, URL) throws -> Void)? = nil) throws {
        guard manifest.kind == injectorKind, manifest.architecture == "arm64", manifest.bundleId == "com.ctrip.vbooking",
              !manifest.version.isEmpty, [manifest.officialSha256, manifest.payloadSha256].allSatisfy({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) else { try fail("安装载荷清单无效") }
        self.manifest = manifest; self.payload = payload.standardizedFileURL; self.target = target.standardizedFileURL
        #if !INSTALLER_TESTING
        guard self.target.path == "/Applications/旅游商家桌面版.app" else { try fail("本版仅支持应用程序目录的官方客户端：/Applications/旅游商家桌面版.app") }
        #endif
        guard self.target.pathExtension == "app", self.target.path == target.path,
              self.target.path == self.target.resolvingSymlinksInPath().path else { try fail("请选择真实的客户端 .app，不能使用符号链接") }
        try secureDirectory(self.target.deletingLastPathComponent())
        self.store = self.target.deletingLastPathComponent().appendingPathComponent(".tsim-injector-" + String(sha(Data(self.target.path.utf8)).prefix(20)))
        self.verifyOfficial = verifyOfficial ?? { app in
            try secureDirectory(app)
            _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", officialRequirement, app.path])
            let identity = try run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", app.appendingPathComponent("Contents/Info.plist").path])
            let version = try run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", app.appendingPathComponent("Contents/Info.plist").path])
            guard identity == manifest.bundleId, version == manifest.vendorVersion, try treeDigest(app) == manifest.officialSha256 else { try fail("客户端版本或文件不兼容。仅支持本安装包验证的官方 \(manifest.vendorVersion)，请重新安装对应官方原版。") }
        }
        self.verifyPayload = verifyPayload ?? { app in
            guard try treeDigest(app) == manifest.payloadSha256 else { try fail("注入载荷校验失败，请重新获取安装包") }
            _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        }
        self.assertIdle = assertIdle ?? {
            let listing = try run("/bin/ps", ["-axww", "-o", "pid=,comm="])
            for line in listing.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let split = trimmed.firstIndex(where: { $0.isWhitespace }) else { continue }
                let path = String(trimmed[split...]).trimmingCharacters(in: .whitespaces).precomposedStringWithCanonicalMapping
                if path.hasPrefix(target.path.precomposedStringWithCanonicalMapping + "/") || path.contains("vbk-electron-updater") || path.contains("/旅游商家助手.app/Contents/") {
                    try fail("请手动完全退出旅游商家桌面版、旅游商家助手和官方更新程序后重试。安装器不会强制结束进程。")
                }
            }
        }
        self.copy = copy ?? { from, to in _ = try run("/usr/bin/ditto", [from.path, to.path]) }
    }
    func validateStore() throws {
        try secureDirectory(store)
        var info = stat(); guard lstat(store.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else { try fail("备份目录权限不匹配，请以原安装权限运行安装器：\(store.path)") }
    }
    func withLock<T>(_ action: () throws -> T) throws -> T {
        if !exists(store) { guard mkdir(store.path, 0o700) == 0 else { try fail("无法创建备份目录，请检查目录写入权限") } }
        try validateStore()
        let fd = open(store.appendingPathComponent("lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { try fail("无法打开安装锁") }; defer { close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFREG,
            flock(fd, LOCK_EX | LOCK_NB) == 0 else { try fail("另一个安装器正在运行，或安装锁不安全") }
        defer { flock(fd, LOCK_UN) }
        return try action()
    }
    func verifyReceipt(_ value: Receipt) throws {
        guard value.kind == injectorKind, value.target == target.path, value.state == "installed",
              value.originalSha256 == manifest.officialSha256 else { try fail("安装收据不兼容，不能覆盖或恢复此客户端") }
        guard try treeDigest(backup) == value.originalSha256 else { try fail("官方备份已变化，已停止操作") }
        guard try treeDigest(target) == value.installedSha256 else { try fail("客户端已被官方更新或文件已变化，已停止操作。请重新安装官方客户端。") }
    }
    func inspect() throws -> Inspection {
        if exists(store) {
            try validateStore()
            if exists(pendingURL) { return Inspection(state: "recovery", message: "上次操作中断。请完全退出客户端，点击安装 / 更新以恢复事务并重新检测。", version: manifest.version, target: target.path, canInstall: true, canRestore: true) }
            if exists(receiptURL) {
                let receipt = try readJSON(Receipt.self, receiptURL); try verifyReceipt(receipt)
                return Inspection(state: "installed", message: "已安装助手 \(receipt.version)，官方原件备份完整。", version: receipt.version, target: target.path, canInstall: true, canRestore: true)
            }
            guard !exists(backup), !exists(previous), !exists(stage) else { try fail("存在无收据的备份或暂存文件，请保留并人工检查：\(store.path)") }
        }
        try verifyOfficial(target)
        return Inspection(state: "compatible", message: "官方客户端 \(manifest.vendorVersion) 的版本、签名及完整文件校验通过。", version: manifest.version, target: target.path, canInstall: true, canRestore: false)
    }
    func recover() throws {
        guard exists(pendingURL) else { return }
        let pending = try readJSON(Receipt.self, pendingURL)
        guard pending.kind == injectorKind, pending.target == target.path, pending.originalSha256 == manifest.officialSha256,
              ["preparing", "installing", "restoring"].contains(pending.state) else { try fail("中断事务收据不匹配") }
        // A fully committed target may be finalized after the last rename but before receipt fsync.
        if pending.state == "installing", exists(target), try treeDigest(target) == pending.installedSha256 {
            guard try treeDigest(backup) == pending.originalSha256 else { try fail("恢复事务时原版备份校验失败") }
            var completed = pending; completed.state = "installed"; try atomicJSON(completed, receiptURL)
        } else if pending.state == "restoring", exists(target), try treeDigest(target) == pending.originalSha256 {
            try? fm.removeItem(at: receiptURL)
        } else {
            let source = pending.hadInstalled ? previous : backup
            if exists(source) {
                if exists(target) { try fail("目标变化，无法自动恢复；所有备份已保留：\(store.path)") }
                let expected: String
                if pending.hadInstalled { expected = try readJSON(Receipt.self, receiptURL).installedSha256 }
                else { expected = pending.originalSha256 }
                guard try treeDigest(source) == expected else { try fail("恢复文件校验失败，所有备份已保留") }
                try fm.moveItem(at: source, to: target)
            } else {
                let expected = pending.hadInstalled ? try readJSON(Receipt.self, receiptURL).installedSha256 : pending.originalSha256
                guard exists(target), try treeDigest(target) == expected else { try fail("中断事务无法自动恢复，备份保留于：\(store.path)") }
            }
        }
        if exists(stage) { try fm.removeItem(at: stage) }
        if exists(previous) { try fm.removeItem(at: previous) }
        try fm.removeItem(at: pendingURL); try syncDirectory(store); try syncDirectory(target.deletingLastPathComponent())
        log("已恢复上次中断的操作。")
    }
    func install() throws {
        try assertIdle(); try verifyPayload(payload)
        try withLock {
            try recover(); let inspection = try inspect()
            let updating = inspection.state == "installed"
            if updating, try readJSON(Receipt.self, receiptURL).installedSha256 == manifest.payloadSha256 { log("当前已是本安装包版本，无需重复注入。"); return }
            log("正在准备助手，保留官方原件。")
            var receipt = Receipt(target: target.path, originalSha256: manifest.officialSha256, installedSha256: manifest.payloadSha256, version: manifest.version, state: "preparing", hadInstalled: updating)
            try atomicJSON(receipt, pendingURL)
            do {
                // Journal preparation too: a crash during ditto leaves a recoverable partial stage.
                try copy(payload, stage); try verifyPayload(stage)
                receipt.state = "installing"; try atomicJSON(receipt, pendingURL)
                try assertIdle()
                if updating { try verifyReceipt(try readJSON(Receipt.self, receiptURL)) } else { try verifyOfficial(target) }
                try fm.moveItem(at: target, to: updating ? previous : backup)
                try fm.moveItem(at: stage, to: target)
                try syncDirectory(target.deletingLastPathComponent()); try syncDirectory(store)
                try verifyPayload(target)
                var committed = receipt; committed.state = "installed"; try atomicJSON(committed, receiptURL)
                if exists(previous) { try fm.removeItem(at: previous) }
                try fm.removeItem(at: pendingURL); try syncDirectory(store)
                log("安装完成。以后直接打开旅游商家桌面版，并在助手内登录 TSIM 账号。")
            } catch {
                // Leave every journal and backup intact when an external write prevents recovery.
                do { try recover() } catch { log("需恢复事务：\(error)。备份保留在 \(store.path)") }
                throw error
            }
        }
    }
    func restore() throws {
        try assertIdle()
        try withLock {
            try recover()
            guard exists(receiptURL) else { try fail("此客户端没有可恢复的安装收据") }
            var receipt = try readJSON(Receipt.self, receiptURL); try verifyReceipt(receipt)
            receipt.state = "restoring"; receipt.hadInstalled = true; try atomicJSON(receipt, pendingURL)
            do {
                try assertIdle(); try verifyReceipt(try readJSON(Receipt.self, receiptURL))
                try fm.moveItem(at: target, to: previous); try fm.moveItem(at: backup, to: target)
                guard try treeDigest(target) == receipt.originalSha256 else { try fail("恢复后的原版校验失败") }
                try syncDirectory(target.deletingLastPathComponent()); try syncDirectory(store)
                try fm.removeItem(at: receiptURL); try fm.removeItem(at: previous); try fm.removeItem(at: pendingURL)
                log("已卸载注入助手并恢复官方原版。账号与客户数据保留。")
            } catch { do { try recover() } catch { log("需恢复事务：\(error)。备份保留在 \(store.path)") }; throw error }
        }
    }
}
