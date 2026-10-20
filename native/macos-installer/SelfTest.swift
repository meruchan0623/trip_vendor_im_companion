// Compile only with Engine.swift. This fixture executable never loads or touches /Applications.
import Foundation

@main struct SelfTest {
    static func main() throws {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--digest" {
            print(try treeDigest(URL(fileURLWithPath: CommandLine.arguments[2]))); return
        }
        let root = fm.temporaryDirectory.appendingPathComponent("tsim-injector-tests-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let original = root.appendingPathComponent("original.app"), target = root.appendingPathComponent("旅游商家桌面版.app"), payload = root.appendingPathComponent("payload.app")
        func make(_ app: URL, _ text: String) throws {
            try fm.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: app.appendingPathComponent("Contents/MacOS/vendor"))
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: app.appendingPathComponent("Contents/MacOS/vendor").path)
            try fm.createSymbolicLink(atPath: app.appendingPathComponent("Contents/link").path, withDestinationPath: "MacOS/vendor")
        }
        try make(original, "official"); try make(payload, "helper-v1"); try fm.copyItem(at: original, to: target)
        let originalHash = try treeDigest(original)
        var manifest = InjectorManifest(kind: injectorKind, version: "1.0.0", architecture: "arm64", bundleId: "com.ctrip.vbooking", vendorVersion: "1.2.12", officialSha256: originalHash, payloadSha256: try treeDigest(payload))
        var idle = true
        func engine(_ config: InjectorManifest) throws -> InjectorEngine {
            try InjectorEngine(manifest: config, payload: payload, target: target,
                verifyOfficial: { guard try treeDigest($0) == originalHash else { try fail("unsupported official") } },
                verifyPayload: { guard try treeDigest($0) == config.payloadSha256 else { try fail("invalid payload") } },
                assertIdle: { guard idle else { try fail("client running") } }, copy: { try fm.copyItem(at: $0, to: $1) })
        }
        var passed = 0
        func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
            guard try value() else { try fail("TEST_FAILED " + message) }; passed += 1; print("PASS " + message)
        }
        func rejects(_ name: String, _ action: () throws -> Void) throws {
            do { try action() } catch { passed += 1; print("PASS " + name + ": " + String(describing: error)); return }
            try fail("TEST_FAILED expected rejection: " + name)
        }
        var e = try engine(manifest)
        try expect(e.inspect().state == "compatible", "official inspection")
        idle = false; try rejects("running client blocked") { try e.install() }; idle = true
        try expect(treeDigest(target) == originalHash, "blocked install preserves target")
        try e.install(); try expect(e.inspect().state == "installed", "install and receipt")
        try expect(treeDigest(e.backup) == originalHash, "backup preserves exact official")
        try e.install(); try expect(treeDigest(e.backup) == originalHash, "idempotent install retains original")
        try Data("helper-v2".utf8).write(to: payload.appendingPathComponent("Contents/MacOS/vendor"))
        manifest.version = "1.0.1"; manifest.payloadSha256 = try treeDigest(payload); e = try engine(manifest)
        try e.install(); try expect(e.inspect().version == "1.0.1", "update installs new version")
        try expect(treeDigest(e.backup) == originalHash, "update retains first official backup")
        let installedV2 = try treeDigest(target)
        try Data("helper-v3".utf8).write(to: payload.appendingPathComponent("Contents/MacOS/vendor"))
        manifest.version = "1.0.2"; manifest.payloadSha256 = try treeDigest(payload); e = try engine(manifest)
        var interruptedUpdate = Receipt(target: target.path, originalSha256: originalHash, installedSha256: manifest.payloadSha256, version: manifest.version, state: "preparing", hadInstalled: true)
        try atomicJSON(interruptedUpdate, e.pendingURL); try make(e.stage, "partial helper copy")
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == installedV2 && !exists(e.stage), "recover update copy preparation")
        interruptedUpdate.state = "installing"
        try atomicJSON(interruptedUpdate, e.pendingURL); try fm.copyItem(at: payload, to: e.stage)
        try fm.moveItem(at: target, to: e.previous)
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == installedV2 && treeDigest(e.backup) == originalHash, "recover between update renames preserves old helper and original")
        try atomicJSON(interruptedUpdate, e.pendingURL); try fm.moveItem(at: target, to: e.previous); try fm.copyItem(at: payload, to: target)
        try e.withLock { try e.recover() }; try expect(e.inspect().version == "1.0.2" && !exists(e.previous), "finalize interrupted update")
        try expect(treeDigest(e.backup) == originalHash, "interrupted updates retain first official backup")
        let currentPayload = try Data(contentsOf: payload.appendingPathComponent("Contents/MacOS/vendor"))
        try Data("tampered payload".utf8).write(to: payload.appendingPathComponent("Contents/MacOS/vendor"))
        try rejects("tampered payload blocks before mutation") { try e.install() }
        try expect(treeDigest(target) == manifest.payloadSha256, "tampered payload leaves installed target intact")
        try currentPayload.write(to: payload.appendingPathComponent("Contents/MacOS/vendor"))
        try Data("official auto update".utf8).write(to: target.appendingPathComponent("Contents/MacOS/vendor"))
        try rejects("drift blocks uninstall") { try e.restore() }
        try rejects("drift blocks update") { try e.install() }
        try expect(String(contentsOf: target.appendingPathComponent("Contents/MacOS/vendor"), encoding: .utf8) == "official auto update", "drifted target untouched")
        try fm.removeItem(at: target); try fm.copyItem(at: payload, to: target)
        try e.restore(); try expect(treeDigest(target) == originalHash, "uninstall restores exact official")
        try expect(!exists(e.receiptURL) && !exists(e.backup), "restore consumes receipt and original backup")
        // Crash during first-install copy preparation.
        let preparing = Receipt(target: target.path, originalSha256: originalHash, installedSha256: manifest.payloadSha256, version: manifest.version, state: "preparing", hadInstalled: false)
        try atomicJSON(preparing, e.pendingURL); try make(e.stage, "partial first copy")
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == originalHash && !exists(e.stage), "recover first-install copy preparation")
        // Crash after journaling, before moving the official client.
        var pending = Receipt(target: target.path, originalSha256: originalHash, installedSha256: manifest.payloadSha256, version: manifest.version, state: "installing", hadInstalled: false)
        try atomicJSON(pending, e.pendingURL); try fm.copyItem(at: payload, to: e.stage)
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == originalHash && !exists(e.stage), "recover before first rename")
        // Crash after saving the official original, before inserting the payload.
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.backup); try fm.copyItem(at: payload, to: e.stage)
        try e.withLock { try e.recover() }; try expect(treeDigest(target) == originalHash && !exists(e.backup), "recover between install renames")
        // Crash after inserting a verified payload, before writing its permanent receipt.
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.backup); try fm.copyItem(at: payload, to: target)
        try e.withLock { try e.recover() }; try expect(e.inspect().state == "installed", "finalize inserted payload after interruption")
        // Crash after moving installed client aside during restore.
        pending.state = "restoring"; pending.hadInstalled = true
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.previous)
        try e.withLock { try e.recover() }; try expect(e.inspect().state == "installed", "recover between restore renames")
        // Crash after restoring official, before deleting receipt/old install.
        try atomicJSON(pending, e.pendingURL); try fm.moveItem(at: target, to: e.previous); try fm.moveItem(at: e.backup, to: target)
        try e.withLock { try e.recover() }; try expect(e.inspect().state == "compatible" && !exists(e.previous), "finalize interrupted restore")
        try fm.createSymbolicLink(at: root.appendingPathComponent("alias.app"), withDestinationURL: target)
        try rejects("symlink target rejected") { _ = try InjectorEngine(manifest: manifest, payload: payload, target: root.appendingPathComponent("alias.app")) }
        // A held advisory lock blocks concurrent mutation and releases automatically on process exit.
        try e.withLock { try rejects("concurrent operation blocked") { try e.withLock {} } }
        try fm.setAttributes([.posixPermissions: 0o777], ofItemAtPath: e.store.path)
        try rejects("writable backup directory rejected") { _ = try e.inspect() }
        print("PASS all \(passed) isolated installer checks")
    }
}
