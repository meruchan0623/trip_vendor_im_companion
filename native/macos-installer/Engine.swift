import Foundation
import CryptoKit
import Darwin

enum InstallFailure: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let text): return text } }
}
func fail(_ text: String) throws -> Never { throw InstallFailure.message(text) }
let packageKind = "trip-vendor-macos-injector-v2"
// Receipts keep the v1 schema (new fields are optional) so earlier installations stay updatable and recoverable.
let receiptKind = "trip-vendor-macos-injector-v1"
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
func fileDigest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    var hash = SHA256()
    while let data = try handle.read(upToCount: 4 * 1024 * 1024), !data.isEmpty { hash.update(data: data) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
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
    var minimumVendorVersion: String
    var testedVendorVersions: [String]
    var componentsSha256: String
}
struct Receipt: Codable {
    var kind: String = receiptKind
    var target: String
    var originalSha256: String
    var installedSha256: String
    var version: String
    var state: String
    var hadInstalled: Bool
    var vendorVersion: String? = nil
    var componentsSha256: String? = nil
    /// Pending journals only: the target build this transaction moves aside. Older journals use the receipt's build.
    var previousSha256: String? = nil
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

/// What the target and the private store currently hold, and what installing or restoring would do.
struct Assessment {
    var state: String
    var message: String
    var receipt: Receipt? = nil
    /// Official bundle to adapt (the target or the retained backup); nil when installation is impossible.
    var source: URL? = nil
    var sourceSha256: String? = nil
    var targetSha256: String? = nil
    /// Injector data no longer describes the target: installing clears it first, restoring only clears it.
    var retire = false
    var canRestore = false
}

final class InjectorEngine {
    let manifest: InjectorManifest, builder: InjectionBuilder, target: URL, store: URL
    let officialSignature: (URL) -> String?, assertIdle: () throws -> Void
    var log: (String) -> Void = { print($0) }
    var receiptURL: URL { store.appendingPathComponent("receipt.json") }
    var pendingURL: URL { store.appendingPathComponent("pending.json") }
    var backup: URL { store.appendingPathComponent("official.app") }
    var stage: URL { store.appendingPathComponent("stage.app") }
    var previous: URL { store.appendingPathComponent("previous.app") }

    init(manifest: InjectorManifest, builder: InjectionBuilder, target: URL,
         officialSignature: ((URL) -> String?)? = nil,
         assertIdle: (() throws -> Void)? = nil) throws {
        guard manifest.kind == packageKind, manifest.architecture == "arm64", manifest.bundleId == "com.ctrip.vbooking", !manifest.version.isEmpty,
              supportedVendorVersion(manifest.minimumVendorVersion), manifest.componentsSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { try fail("安装包清单无效") }
        self.manifest = manifest; self.builder = builder; self.target = target.standardizedFileURL
        #if !INSTALLER_TESTING
        guard self.target.path == "/Applications/旅游商家桌面版.app" else { try fail("本版仅支持应用程序目录的官方客户端：/Applications/旅游商家桌面版.app") }
        #endif
        guard self.target.pathExtension == "app", self.target.path == target.path,
              self.target.path == self.target.resolvingSymlinksInPath().path else { try fail("请选择真实的客户端 .app，不能使用符号链接") }
        try secureDirectory(self.target.deletingLastPathComponent())
        self.store = self.target.deletingLastPathComponent().appendingPathComponent(".tsim-injector-" + String(sha(Data(self.target.path.utf8)).prefix(20)))
        self.officialSignature = officialSignature ?? { app in
            do { _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", officialRequirement, app.path]); return nil }
            catch { return String(describing: error).split(separator: "\n").dropFirst().last.map { "官方签名校验未通过：" + $0 } ?? "官方签名校验未通过" }
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
    func blocked(_ message: String) -> Assessment { Assessment(state: "blocked", message: message) }
    /// Reports the state even when `source` cannot be adapted; installation is then disabled with the reason.
    func adapt(_ state: String, _ lead: String, from source: URL, sourceSha256: String, targetSha256: String, receipt: Receipt? = nil) -> Assessment {
        var result = Assessment(state: state, message: lead, receipt: receipt, targetSha256: targetSha256, canRestore: receipt != nil)
        do {
            let vendor = try builder.preflight(source)
            let tested = manifest.testedVendorVersions.contains(vendor.version) ? "此安装包已验证该版本" : "此安装包未专门验证该版本，将按结构兼容规则适配"
            result.source = source; result.sourceSha256 = sourceSha256
            result.message = "\(lead)\n可注入的官方客户端 \(vendor.version)（Electron \(vendor.electron)，页面 \(vendor.page["aresVersion"] ?? "?")）：\(tested)。"
        } catch { result.message = "\(lead)\n无法注入：\(error)" }
        return result
    }
    func assess() throws -> Assessment {
        if exists(store) {
            try validateStore()
            if exists(pendingURL) { return Assessment(state: "recovery", message: "上次操作中断。请完全退出客户端，点击安装 / 更新以恢复事务并重新检测。", canRestore: true) }
        }
        guard exists(target) else { return blocked("未找到客户端：\(target.path)。请先从官方 DMG 安装旅游商家桌面版，再点击检查。") }
        let info = try readPlist(target.appendingPathComponent("Contents/Info.plist")).value
        guard info["CFBundleIdentifier"] as? String == manifest.bundleId else { return blocked("所选应用不是旅游商家桌面版（Bundle ID 不符）。") }
        let injected = info["CFBundleExecutable"] as? String == launcherName, targetSha256 = try treeDigest(target)
        if exists(store), exists(receiptURL) {
            let receipt = try readJSON(Receipt.self, receiptURL)
            guard receipt.kind == receiptKind, receipt.target == target.path, receipt.state == "installed" else { return blocked("安装收据不兼容，已停止。请保留并人工检查：\(store.path)") }
            let backupIntact = exists(backup) && (try? treeDigest(backup)) == receipt.originalSha256
            if targetSha256 == receipt.installedSha256 {
                guard backupIntact else { return blocked("官方原件备份已变化或缺失，无法更新或卸载。请从官方 DMG 重新安装旅游商家桌面版（直接覆盖），然后点击检查。") }
                return adapt("installed", "已安装助手 \(receipt.version)，官方原件备份完整。", from: backup, sourceSha256: receipt.originalSha256, targetSha256: targetSha256, receipt: receipt)
            }
            let signature = injected ? nil : officialSignature(target)
            if !injected && (signature == nil || !backupIntact) {
                var result = adapt("replaced", "官方客户端已覆盖之前的注入（重新安装或官方更新）\(signature.map { "；" + $0 } ?? "")。安装会基于当前客户端重新注入并更新官方原件备份；卸载只清理旧备份，不改动当前客户端。", from: target, sourceSha256: targetSha256, targetSha256: targetSha256)
                result.retire = true; result.canRestore = true
                return result
            }
            guard backupIntact else { return blocked("当前客户端与安装记录不一致，且官方原件备份已变化或缺失。请从官方 DMG 重新安装旅游商家桌面版（直接覆盖），然后点击检查。") }
            return adapt("drifted", "当前客户端与安装记录不一致（\(signature ?? "可能来自其他版本的安装器或手动复制")）。安装会基于完整的官方原件备份重新注入；卸载会恢复该官方原版。", from: backup, sourceSha256: receipt.originalSha256, targetSha256: targetSha256, receipt: receipt)
        }
        if exists(store), [backup, previous, stage].contains(where: exists) {
            guard !injected else { return blocked("存在无收据的备份或暂存文件，且客户端已被注入。请保留并人工检查：\(store.path)") }
            var result = adapt("replaced", "发现之前遗留的助手备份文件；安装或卸载会先清理这些文件，不改动当前客户端。", from: target, sourceSha256: targetSha256, targetSha256: targetSha256)
            result.retire = true; result.canRestore = true
            return result
        }
        guard !injected else { return blocked("此客户端已被注入，但本机没有对应的官方原件备份。请从官方 DMG 重新安装旅游商家桌面版（直接覆盖），然后点击检查。") }
        let signature = officialSignature(target)
        return adapt("compatible", signature.map { "\($0)。仍可尝试注入；卸载时会恢复为当前这份客户端。" } ?? "官方签名校验通过。", from: target, sourceSha256: targetSha256, targetSha256: targetSha256)
    }
    func inspect() throws -> Inspection {
        let result = try assess()
        return Inspection(state: result.state, message: result.message, version: result.receipt?.version ?? manifest.version, target: target.path,
                          canInstall: result.source != nil || result.state == "recovery", canRestore: result.canRestore)
    }
    /// Journaled removal of injector data that no longer describes the target. The target is never touched.
    func retire(_ targetSha256: String) throws {
        try atomicJSON(Receipt(target: target.path, originalSha256: targetSha256, installedSha256: targetSha256, version: manifest.version, state: "retiring", hadInstalled: false), pendingURL)
        try finishRetire()
    }
    func finishRetire() throws {
        for item in [receiptURL, backup, stage, previous] where exists(item) { try fm.removeItem(at: item) }
        try fm.removeItem(at: pendingURL); try syncDirectory(store)
        log("已清理旧的助手备份与收据，当前客户端未改动。")
    }
    func recover() throws {
        guard exists(pendingURL) else { return }
        let pending = try readJSON(Receipt.self, pendingURL)
        guard pending.kind == receiptKind, pending.target == target.path,
              ["preparing", "installing", "restoring", "retiring"].contains(pending.state) else { try fail("中断事务收据不匹配，请保留并人工检查：\(store.path)") }
        if pending.state == "retiring" {
            guard exists(target), try treeDigest(target) == pending.originalSha256 else { try fail("中断的清理无法继续：客户端已变化，备份保留于：\(store.path)") }
            try finishRetire(); return
        }
        // A fully committed target may be finalized after the last rename but before receipt fsync.
        if pending.state == "installing", exists(target), try treeDigest(target) == pending.installedSha256 {
            guard try treeDigest(backup) == pending.originalSha256 else { try fail("恢复事务时原版备份校验失败") }
            var completed = pending; completed.state = "installed"; completed.previousSha256 = nil; try atomicJSON(completed, receiptURL)
        } else if pending.state == "restoring", exists(target), try treeDigest(target) == pending.originalSha256 {
            try? fm.removeItem(at: receiptURL)
        } else {
            let source = pending.hadInstalled ? previous : backup
            let expected = pending.hadInstalled ? try pending.previousSha256 ?? readJSON(Receipt.self, receiptURL).installedSha256 : pending.originalSha256
            if exists(source) {
                if exists(target) { try fail("目标变化，无法自动恢复；所有备份已保留：\(store.path)") }
                guard try treeDigest(source) == expected else { try fail("恢复文件校验失败，所有备份已保留") }
                try fm.moveItem(at: source, to: target)
            } else {
                guard exists(target), try treeDigest(target) == expected else { try fail("中断事务无法自动恢复，备份保留于：\(store.path)") }
            }
        }
        if exists(stage) { try fm.removeItem(at: stage) }
        if exists(previous) { try fm.removeItem(at: previous) }
        try fm.removeItem(at: pendingURL); try syncDirectory(store); try syncDirectory(target.deletingLastPathComponent())
        log("已恢复上次中断的操作。")
    }
    func install() throws {
        try assertIdle(); try builder.verifyComponents(manifest.componentsSha256)
        try withLock {
            try recover(); var assessment = try assess()
            guard let source = assessment.source, let sourceSha256 = assessment.sourceSha256, let targetSha256 = assessment.targetSha256 else { try fail(assessment.message) }
            if assessment.state == "installed", let receipt = assessment.receipt, receipt.version == manifest.version, receipt.componentsSha256 == manifest.componentsSha256 { log("当前已是本安装包版本，无需重复注入。"); return }
            if assessment.retire { try retire(targetSha256); assessment.receipt = nil }
            // With a receipt the retained official backup is adapted and the current target moves aside.
            let updating = assessment.receipt != nil
            log(updating ? "正在基于官方原件备份重新注入助手。" : "正在基于当前官方客户端注入助手，并保留官方原件。")
            var journal = Receipt(target: target.path, originalSha256: sourceSha256, installedSha256: "", version: manifest.version, state: "preparing", hadInstalled: updating,
                                  componentsSha256: manifest.componentsSha256, previousSha256: updating ? targetSha256 : nil)
            try atomicJSON(journal, pendingURL)
            do {
                // Journal preparation too: a crash while building leaves a recoverable partial stage.
                let built = try builder.build(from: source, into: stage, expected: sourceSha256)
                journal.installedSha256 = built.digest; journal.vendorVersion = built.vendor.version; journal.state = "installing"; try atomicJSON(journal, pendingURL)
                try assertIdle()
                guard try treeDigest(target) == targetSha256, try !updating || treeDigest(backup) == sourceSha256 else { try fail("客户端或官方备份在安装过程中发生变化，已停止") }
                try fm.moveItem(at: target, to: updating ? previous : backup)
                try fm.moveItem(at: stage, to: target)
                try syncDirectory(target.deletingLastPathComponent()); try syncDirectory(store)
                guard try treeDigest(target) == built.digest else { try fail("安装后的客户端校验失败") }
                var committed = journal; committed.state = "installed"; committed.previousSha256 = nil; try atomicJSON(committed, receiptURL)
                if exists(previous) { try fm.removeItem(at: previous) }
                try fm.removeItem(at: pendingURL); try syncDirectory(store)
                log("安装完成（官方客户端 \(built.vendor.version)）。以后直接打开旅游商家桌面版，并在助手内登录 TSIM 账号。")
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
            try recover(); let assessment = try assess()
            guard assessment.canRestore, let targetSha256 = assessment.targetSha256 else { try fail(assessment.state == "compatible" ? "此客户端没有可恢复的安装收据" : assessment.message) }
            if assessment.retire { try retire(targetSha256); return }
            guard let receipt = assessment.receipt else { try fail("此客户端没有可恢复的安装收据") }
            var journal = receipt; journal.state = "restoring"; journal.hadInstalled = true; journal.previousSha256 = targetSha256
            try atomicJSON(journal, pendingURL)
            do {
                try assertIdle()
                guard try treeDigest(target) == targetSha256, try treeDigest(backup) == receipt.originalSha256 else { try fail("客户端或官方备份在操作过程中发生变化，已停止") }
                try fm.moveItem(at: target, to: previous); try fm.moveItem(at: backup, to: target)
                guard try treeDigest(target) == receipt.originalSha256 else { try fail("恢复后的原版校验失败") }
                try syncDirectory(target.deletingLastPathComponent()); try syncDirectory(store)
                try fm.removeItem(at: receiptURL); try fm.removeItem(at: previous); try fm.removeItem(at: pendingURL)
                log("已卸载注入助手并恢复官方原版。账号与客户数据保留。")
            } catch { do { try recover() } catch { log("需恢复事务：\(error)。备份保留在 \(store.path)") }; throw error }
        }
    }
}
