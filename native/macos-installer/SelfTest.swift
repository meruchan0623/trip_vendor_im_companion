// Compile only with Engine.swift and Injection.swift. This fixture executable never loads or touches /Applications.
import Foundation

@main struct SelfTest {
    static func main() throws {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--digest" {
            print(try treeDigest(URL(fileURLWithPath: CommandLine.arguments[2]))); return
        }
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--macho" {
            print(try unsignedMachOHash(URL(fileURLWithPath: CommandLine.arguments[2]))); return
        }
        let root = fm.temporaryDirectory.appendingPathComponent("tsim-injector-tests-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        var passed = 0
        func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
            guard try value() else { try fail("TEST_FAILED " + message) }; passed += 1; print("PASS " + message)
        }
        func rejects(_ name: String, _ pattern: String? = nil, _ action: () throws -> Void) throws {
            do { try action() } catch {
                let text = String(describing: error)
                if let pattern, !text.contains(pattern) { try fail("TEST_FAILED \(name): unexpected rejection \(text)") }
                passed += 1; print("PASS " + name + ": " + text.replacingOccurrences(of: "\n", with: " ")); return
            }
            try fail("TEST_FAILED expected rejection: " + name)
        }
        func write(_ text: String, _ url: URL) throws {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }
        func plist(_ value: [String: Any], _ url: URL) throws {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try writePlist(value, .xml, url)
        }

        // A real signed Mach-O: ad hoc re-signing must not change its unsigned fingerprint.
        let source = root.appendingPathComponent("fixture.c"), machO = root.appendingPathComponent("fixture-exe")
        try write("int main(void){return 0;}\n", source)
        _ = try run("/usr/bin/xcrun", ["clang", "-arch", "arm64", "-o", machO.path, source.path])
        _ = try run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "com.example.first", machO.path])
        let fingerprint = try unsignedMachOHash(machO)
        _ = try run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "com.example.a.much.longer.identifier", machO.path])
        try expect(unsignedMachOHash(machO) == fingerprint, "Mach-O fingerprint ignores the embedded signature")
        try write("not a binary", root.appendingPathComponent("plain"))
        try rejects("non Mach-O executable rejected", "Mach-O") { _ = try unsignedMachOHash(root.appendingPathComponent("plain")) }

        try expect(["1.2.11", "1.2.12", "1.2.11.7", "1.3.0", "2.0.0"].allSatisfy(supportedVendorVersion) && !["1.2.10", "1.1.99", "1.2", "1.2.x"].contains(where: supportedVendorVersion), "1.2.11 and later are supported")

        // Synthetic ASAR: two pickles followed by packed bytes; nested entries mirror the vendor layout.
        func makeAsar(_ url: URL, _ entries: [(String, Data)]) throws {
            var tree: [String: Any] = [:], data = Data()
            func insert(_ parts: ArraySlice<Substring>, _ node: inout [String: Any], _ file: [String: Any]) {
                var files = node["files"] as? [String: Any] ?? [:]
                if parts.count == 1 { files[String(parts.first!)] = file } else {
                    var child = files[String(parts.first!)] as? [String: Any] ?? [:]; insert(parts.dropFirst(), &child, file); files[String(parts.first!)] = child
                }
                node["files"] = files
            }
            for (path, bytes) in entries { insert(path.split(separator: "/")[...], &tree, ["size": bytes.count, "offset": String(data.count)]); data.append(bytes) }
            let text = try compactJSON(tree), padded = (text.count + 3) / 4 * 4
            var head = Data(count: 16 + padded)
            for (index, value) in [4, 8 + padded, 4 + padded, text.count].enumerated() { for byte in 0..<4 { head[index * 4 + byte] = UInt8((value >> (8 * byte)) & 0xff) } }
            head.replaceSubrange(16..<(16 + text.count), with: text)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (head + data).write(to: url)
        }
        func readAsar(_ url: URL) throws -> (header: [String: Any], headerSha256: String, file: (String) -> Data?) {
            let bytes = try Data(contentsOf: url)
            func u32(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 | Int(bytes[at + 2]) << 16 | Int(bytes[at + 3]) << 24 }
            let text = bytes.subdata(in: 16..<(16 + u32(12))), start = 8 + u32(4)
            let header = try JSONSerialization.jsonObject(with: text) as! [String: Any]
            return (header, sha(text), { path in
                var node: Any? = header
                for part in path.split(separator: "/") { node = ((node as? [String: Any])?["files"] as? [String: Any])?[String(part)] }
                guard let entry = node as? [String: Any], let offset = Int(entry["offset"] as! String), let size = entry["size"] as? Int else { return nil }
                return bytes.subdata(in: (start + offset)..<(start + offset + size))
            })
        }
        let html = { (script: String) in "<!doctype html><html><head><script type=\"module\" crossorigin src=\"../../../js/\(script)\"></script></head><body><div id=\"root\"></div></body></html>" }
        func makeVendor(_ app: URL, version: String, ares: String = "1.2.14", marker: String, entry: String? = nil, pageContract: Bool = true) throws {
            try plist(["CFBundleIdentifier": "com.ctrip.vbooking", "CFBundleShortVersionString": version, "CFBundleVersion": version, "CFBundleExecutable": vendorExecutableName,
                       "ElectronAsarIntegrity": ["Resources/app.asar": ["algorithm": "SHA256", "hash": String(repeating: "0", count: 64)]]], app.appendingPathComponent("Contents/Info.plist"))
            try fm.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
            try fm.copyItem(at: machO, to: app.appendingPathComponent("Contents/MacOS/" + vendorExecutableName))
            try plist(["CFBundleVersion": "27.3.11"], app.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"))
            try fm.createSymbolicLink(atPath: app.appendingPathComponent("Contents/Frameworks/link").path, withDestinationPath: "Electron Framework.framework")
            try makeAsar(app.appendingPathComponent("Contents/Resources/app.asar"), [
                ("package.json", Data(#"{"name":"vbk","version":"\#(version)","main":"dist-electron/main/index.js"}"#.utf8)),
                ("dist-electron/main/index.js", Data((entry ?? entryContract.joined(separator: ";") + "//" + marker).utf8)),
            ])
            let dist = app.appendingPathComponent("Contents/Resources/app.asar.unpacked/dist"), suffix = ares.replacingOccurrences(of: ".", with: "")
            try write(#"{"pkgVersion":"\#(version)","aresVersion":"\#(ares)"}"#, dist.appendingPathComponent("packageVersion.json"))
            try write(html("imWindow-A\(suffix).js"), dist.appendingPathComponent("src/pages/imPlus/index.html"))
            try write(html("mainWindow-B\(suffix).js"), dist.appendingPathComponent("src/pages/main/index.html"))
            try write((pageContract ? imContract : ["chat-editor"]).joined(separator: ";"), dist.appendingPathComponent("js/imWindow-A\(suffix).js"))
            try write(navigationContract.joined(separator: ";"), dist.appendingPathComponent("js/mainWindow-B\(suffix).js"))
        }
        let components = root.appendingPathComponent("components")
        try write("launcher-binary", components.appendingPathComponent(launcherName))
        try plist(["CFBundleExecutable": "旅游商家助手"], components.appendingPathComponent(helperName + "/Contents/Info.plist"))
        try write("helper-binary", components.appendingPathComponent(helperName + "/Contents/MacOS/旅游商家助手"))
        try write("'use strict';\n", components.appendingPathComponent(bootstrapName))
        var signed: [String] = []
        let builder = InjectionBuilder(components: components); builder.sign = { signed.append($0.lastPathComponent) }

        // Builder pieces on their own.
        let official = root.appendingPathComponent("official-1.2.11.app"), update = root.appendingPathComponent("official-1.2.12.app")
        try makeVendor(official, version: "1.2.11", marker: "official 1.2.11"); try makeVendor(update, version: "1.2.12", ares: "1.2.16", marker: "official 1.2.12")
        let vendor = try builder.preflight(official)
        try expect(vendor.version == "1.2.11" && vendor.chromiumMajor == 118 && vendor.page["rendererName"] == "imWindow-A1214.js" && vendor.page.count == 8, "preflight probes version, Electron and pages")
        let patched = root.appendingPathComponent("patched.asar"), patch = try patchVendorAsar(official.appendingPathComponent("Contents/Resources/app.asar"), patched, bootstrap: Data("boot".utf8))
        let archive = try readAsar(patched)
        let package = try JSONSerialization.jsonObject(with: archive.file("package.json")!) as! [String: Any]
        try expect(package["main"] as? String == bootstrapName && package["version"] as? String == "1.2.11" && archive.file(bootstrapName) == Data("boot".utf8), "archive entry redirects to the bootstrap")
        try expect(String(decoding: archive.file(originalMainName)!, as: UTF8.self) == "{\"main\":\"dist-electron/main/index.js\"}\n" && archive.file("dist-electron/main/index.js") != nil, "original main and packed bytes are retained")
        try expect(patch.headerSha256 == archive.headerSha256 && patch.sha256 == (try fileDigest(patched)), "integrity hashes describe the written archive")
        try rejects("patched archive cannot be patched twice", "已被修改") { _ = try patchVendorAsar(patched, root.appendingPathComponent("twice.asar"), bootstrap: Data()) }
        let odd = root.appendingPathComponent("odd.app"); try makeVendor(odd, version: "1.2.11", marker: "", entry: "app.whenReady()")
        try rejects("incompatible vendor entry rejected", "启动入口") { _ = try patchVendorAsar(odd.appendingPathComponent("Contents/Resources/app.asar"), root.appendingPathComponent("odd.asar"), bootstrap: Data()) }
        let old = root.appendingPathComponent("old.app"); try makeVendor(old, version: "1.2.10", marker: "old")
        try rejects("1.2.10 rejected by preflight", "过旧") { _ = try builder.preflight(old) }
        let noContract = root.appendingPathComponent("contract.app"); try makeVendor(noContract, version: "1.2.11", marker: "", pageContract: false)
        try rejects("page contract enforced", "页面功能结构") { _ = try builder.preflight(noContract) }

        let target = root.appendingPathComponent("旅游商家桌面版.app")
        let officialDigests: Set<String> = [try treeDigest(official), try treeDigest(update)]
        var idle = true
        func engine(_ version: String = "1.0.0", components digest: String? = nil) throws -> InjectorEngine {
            let manifest = InjectorManifest(kind: packageKind, version: version, architecture: "arm64", bundleId: "com.ctrip.vbooking", minimumVendorVersion: "1.2.11",
                                            testedVendorVersions: ["1.2.12"], componentsSha256: try digest ?? treeDigest(components))
            let result = try InjectorEngine(manifest: manifest, builder: builder, target: target,
                officialSignature: { (try? treeDigest($0)).map(officialDigests.contains) == true ? nil : "官方签名校验未通过：fixture" },
                assertIdle: { guard idle else { try fail("client running") } })
            result.log = { print("  log: " + $0) }
            return result
        }
        func installed(_ app: URL) throws -> [String: Any] {
            let info = try readPlist(app.appendingPathComponent("Contents/Info.plist")).value
            guard info["CFBundleExecutable"] as? String == launcherName else { return [:] }
            return try JSONSerialization.jsonObject(with: Data(contentsOf: app.appendingPathComponent("Contents/Resources/companion/vendor-runtime-manifest.json"))) as! [String: Any]
        }
        func replace(_ app: URL, with source: URL) throws { if exists(app) { try fm.removeItem(at: app) }; try fm.copyItem(at: source, to: app) }

        // Fresh installation of an unverified-but-compatible 1.2.11.
        try replace(target, with: official)
        var e = try engine(), originalHash = try treeDigest(official)
        var inspection = try e.inspect()
        try expect(inspection.state == "compatible" && inspection.canInstall && !inspection.canRestore && inspection.message.contains("未专门验证"), "fresh 1.2.11 inspection")
        idle = false; try rejects("running client blocked", "client running") { try e.install() }; idle = true
        try expect(treeDigest(target) == originalHash, "blocked install preserves target")
        try e.install()
        var runtime = try installed(target), info = try readPlist(target.appendingPathComponent("Contents/Info.plist")).value
        try expect(runtime["executableVersion"] as? String == "1.2.11" && runtime["executable"] as? String == installedExecutable && runtime["chromiumMajor"] as? Int == 118 && runtime["executableSha256"] as? String == fingerprint, "runtime manifest records the detected client")
        try expect(runtime["asarSha256"] as? String == (try fileDigest(target.appendingPathComponent("Contents/Resources/app.asar"))) && ((info["ElectronAsarIntegrity"] as? [String: Any])?["Resources/app.asar"] as? [String: Any])?["hash"] as? String == (try readAsar(target.appendingPathComponent("Contents/Resources/app.asar"))).headerSha256, "archive and integrity hash agree")
        try expect(String(decoding: try Data(contentsOf: target.appendingPathComponent("Contents/Resources/companion/launcher.json")), as: UTF8.self) == "{\"companionExecutable\":\"旅游商家助手\",\"vendorExecutable\":\"旅游商家桌面版\"}" && exists(target.appendingPathComponent("Contents/MacOS/" + launcherName)), "launcher and helper inserted")
        try expect(treeDigest(e.backup) == originalHash && e.inspect().state == "installed" && signed == ["stage.app"], "backup preserves exact official and stage is signed")
        let installedV1 = try treeDigest(target)
        try e.install(); try expect(treeDigest(target) == installedV1 && signed.count == 1, "idempotent install keeps the current build")
        e = try engine("1.0.1"); try e.install()
        try expect(e.inspect().version == "1.0.1" && treeDigest(e.backup) == originalHash && !exists(e.previous), "installer update re-adapts the retained backup")

        // Official reinstall over the injection, then an official update: both are adapted again.
        try replace(target, with: official)
        inspection = try e.inspect()
        try expect(inspection.state == "replaced" && inspection.canInstall && inspection.canRestore, "official reinstall is recognized instead of blocking")
        try e.install(); try expect(e.inspect().state == "installed" && treeDigest(e.backup) == originalHash, "reinstalled official is injected again")
        try replace(target, with: update)
        inspection = try e.inspect()
        try expect(inspection.state == "replaced" && inspection.message.contains("已验证该版本"), "official update to tested 1.2.12 recognized")
        try e.install()
        runtime = try installed(target)
        try expect(runtime["executableVersion"] as? String == "1.2.12" && (runtime["bundledPage"] as? [String: String])?["aresVersion"] == "1.2.16" && treeDigest(e.backup) == (try treeDigest(update)), "update is adapted and becomes the official backup")
        try expect(try readJSON(Receipt.self, e.receiptURL).vendorVersion == "1.2.12", "receipt records the adapted client version")
        originalHash = try treeDigest(update)

        // Drifted injected files: reinstall from the intact backup, or restore it.
        try write("{}", target.appendingPathComponent("Contents/Resources/companion/launcher.json"))
        try expect(e.inspect().state == "drifted", "drifted injection recognized")
        let drifted = try treeDigest(target)
        idle = false; try rejects("drift repair waits for idle client") { try e.install() }; idle = true
        try expect(treeDigest(target) == drifted && !exists(e.pendingURL), "aborted repair leaves the drifted target")
        try e.install(); try expect(e.inspect().state == "installed" && treeDigest(e.backup) == originalHash, "drifted injection rebuilt from backup")
        try write("{}", target.appendingPathComponent("Contents/Resources/companion/launcher.json"))
        try e.restore(); try expect(treeDigest(target) == originalHash && !exists(e.receiptURL) && !exists(e.backup), "drifted injection restored to official")
        try expect(e.inspect().state == "compatible", "restored client is installable again")

        // Restore after an official reinstall only clears stale data.
        try e.install(); try replace(target, with: update)
        try e.restore(); try expect(treeDigest(target) == originalHash && !exists(e.receiptURL) && !exists(e.backup) && e.inspect().state == "compatible", "replaced restore clears backup without touching client")

        // Clients without a usable official source are blocked with guidance, not dead ends.
        try e.install(); try fm.removeItem(at: e.store)
        try expect(e.inspect().state == "blocked" && !e.inspect().canInstall, "injected client without backup is blocked")
        try replace(target, with: official); try expect(e.inspect().state == "compatible", "reinstalling official clears the block")
        try replace(target, with: old); inspection = try e.inspect()
        try expect(inspection.state == "compatible" && !inspection.canInstall && inspection.message.contains("过旧"), "1.2.10 reported but not installable")
        try rejects("1.2.10 install rejected", "过旧") { try e.install() }
        let unsigned = root.appendingPathComponent("unsigned.app"); try makeVendor(unsigned, version: "1.2.12", marker: "modified vendor")
        try replace(target, with: unsigned); inspection = try e.inspect()
        try expect(inspection.state == "compatible" && inspection.canInstall && inspection.message.contains("签名校验未通过"), "unsigned compatible client installable with warning")
        try replace(target, with: official)

        // Legacy 0.6.x receipt and journal schema remain recoverable.
        try e.install(); originalHash = try treeDigest(official)
        let current = try treeDigest(target)
        var legacy = try readJSON(Receipt.self, e.receiptURL); legacy.componentsSha256 = nil; legacy.vendorVersion = nil; legacy.version = "0.6.3"
        try atomicJSON(legacy, e.receiptURL)
        try expect(e.inspect().state == "installed", "legacy receipt accepted")
        var journal = legacy; journal.state = "installing"; journal.installedSha256 = String(repeating: "f", count: 64); journal.hadInstalled = true
        try atomicJSON(journal, e.pendingURL); try fm.moveItem(at: target, to: e.previous); try write("partial", e.stage.appendingPathComponent("x"))
        try expect(e.inspect().state == "recovery", "interrupted legacy journal reported")
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == current && !exists(e.previous) && !exists(e.stage), "legacy journal rolls back to receipt build")
        e = try engine("1.0.2"); try e.install(); try expect(e.inspect().version == "1.0.2", "legacy installation upgraded")

        // Crash points of the new transactions.
        let installedNow = try treeDigest(target)
        var pending = Receipt(target: target.path, originalSha256: originalHash, installedSha256: "", version: "1.0.3", state: "preparing", hadInstalled: true, previousSha256: installedNow)
        try atomicJSON(pending, e.pendingURL); try write("partial", e.stage.appendingPathComponent("x"))
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == installedNow && !exists(e.stage), "recover interrupted preparation")
        try write("{}", target.appendingPathComponent("Contents/Resources/companion/launcher.json")); let drift = try treeDigest(target)
        pending = try readJSON(Receipt.self, e.receiptURL); pending.state = "restoring"; pending.hadInstalled = true; pending.previousSha256 = drift
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.previous)
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == drift && exists(e.backup), "recover between drifted restore renames")
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.previous); try fm.moveItem(at: e.backup, to: target)
        try e.withLock { try e.recover() }; try expect(e.inspect().state == "compatible" && !exists(e.previous), "finalize interrupted restore")
        try e.install(); let reinstalled = try treeDigest(target)
        try fm.removeItem(at: target); try fm.copyItem(at: update, to: target); let updateHash = try treeDigest(update)
        try atomicJSON(Receipt(target: target.path, originalSha256: updateHash, installedSha256: updateHash, version: "1.0.3", state: "retiring", hadInstalled: false), e.pendingURL)
        try fm.removeItem(at: e.receiptURL)
        try e.withLock { try e.recover() }; try expect(!exists(e.backup) && !exists(e.pendingURL) && treeDigest(target) == updateHash, "finish interrupted retirement")
        try expect(reinstalled != updateHash && e.inspect().state == "compatible", "retired store is clean")
        pending = Receipt(target: target.path, originalSha256: updateHash, installedSha256: String(repeating: "e", count: 64), version: "1.0.3", state: "installing", hadInstalled: false)
        try e.install(); let fresh = try treeDigest(target); try e.restore()
        pending.installedSha256 = fresh
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.backup); try fm.copyItem(at: e.backup, to: e.stage)
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == updateHash && !exists(e.backup), "recover between first-install renames")
        try e.install(); try fm.removeItem(at: e.receiptURL)
        try expect(treeDigest(target) == fresh, "rebuilding the same client is byte-identical")
        try atomicJSON(pending, e.pendingURL)
        try e.withLock { try e.recover() }; try expect(e.inspect().state == "installed", "finalize inserted build after interruption")

        // Package and path safety.
        try write("tampered", components.appendingPathComponent(bootstrapName))
        try rejects("tampered components block before mutation", "组件") { try e.install() }
        try fm.createSymbolicLink(at: root.appendingPathComponent("alias.app"), withDestinationURL: target)
        try rejects("symlink target rejected") { _ = try InjectorEngine(manifest: e.manifest, builder: builder, target: root.appendingPathComponent("alias.app")) }
        // A held advisory lock blocks concurrent mutation and releases automatically on process exit.
        try e.withLock { try rejects("concurrent operation blocked") { try e.withLock {} } }
        try fm.setAttributes([.posixPermissions: 0o777], ofItemAtPath: e.store.path)
        try rejects("writable backup directory rejected") { _ = try e.inspect() }
        print("PASS all \(passed) isolated installer checks")
    }
}
