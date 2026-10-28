// Real Engine + InjectionBuilder integration. No installed application is read or launched.
import Foundation
import Darwin

func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { try fail("TEST FAILURE: " + message) }
}
func rejects(_ fragment: String, _ action: () throws -> Void) throws {
    do { try action() } catch {
        try check(String(describing: error).contains(fragment), "expected error containing \(fragment), got \(error)")
        return
    }
    try fail("TEST FAILURE: expected rejection containing \(fragment)")
}
func put(_ data: Data, _ url: URL) throws {
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
}
func put(_ text: String, _ url: URL) throws { try put(Data(text.utf8), url) }
func plist(_ value: [String: Any], _ url: URL) throws {
    try put(PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0), url)
}
func word(_ value: Int, _ data: inout Data, _ offset: Int) {
    for byte in 0..<4 { data[offset + byte] = UInt8((value >> (byte * 8)) & 255) }
}
func vendor(_ target: URL, _ version: String = "1.2.11") throws {
    try plist(["CFBundleIdentifier": "com.ctrip.vbooking", "CFBundleExecutable": vendorExecutableName,
               "CFBundleShortVersionString": version, "CFBundleVersion": version + ".1"], target.appendingPathComponent("Contents/Info.plist"))
    try plist(["CFBundleVersion": "27.1.0"], target.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"))
    // Structurally valid, inert Mach-O fingerprint fixture; never executable or launched.
    var macho = Data(count: 160)
    for (offset, value) in [(0, 0xfeedfacf), (16, 2), (20, 88), (32, 0x19), (36, 72), (72, 128), (80, 32), (104, 0x1d), (108, 16), (112, 144), (116, 16)] { word(value, &macho, offset) }
    macho.replaceSubrange(40..<50, with: Data("__LINKEDIT".utf8))
    try put(macho, target.appendingPathComponent("Contents/MacOS/" + vendorExecutableName))
    let packed = [try compactJSON(["main": "main.cjs"]), Data(entryContract.joined(separator: " ").utf8)]
    let header = try compactJSON(["files": ["package.json": ["offset": "0", "size": packed[0].count], "main.cjs": ["offset": String(packed[0].count), "size": packed[1].count]]])
    let padded = (header.count + 3) / 4 * 4
    var asar = Data(count: 16 + padded)
    for (index, value) in [4, 8 + padded, 4 + padded, header.count].enumerated() { word(value, &asar, index * 4) }
    asar.replaceSubrange(16..<(16 + header.count), with: header)
    for bytes in packed { asar.append(bytes) }
    try put(asar, target.appendingPathComponent("Contents/Resources/app.asar"))
    let dist = target.appendingPathComponent("Contents/Resources/app.asar.unpacked/dist")
    try put(try compactJSON(["pkgVersion": version, "aresVersion": "1.2.3"]), dist.appendingPathComponent("packageVersion.json"))
    for (page, name, contract) in [("imPlus", "imWindow-fixture.js", imContract), ("main", "mainWindow-fixture.js", navigationContract)] {
        try put("<div id='root'></div><script type='module' src='../../../js/\(name)'></script>", dist.appendingPathComponent("src/pages/\(page)/index.html"))
        try put(contract.joined(separator: " "), dist.appendingPathComponent("js/" + name))
    }
}
final class Fixture {
    let target: URL, components: URL, builder: InjectionBuilder
    let original: String
    var idleCalls = 0
    var idleAction: ((Int) throws -> Void)?
    init(_ root: URL, _ name: String) throws {
        let folder = root.appendingPathComponent(name)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        target = folder.appendingPathComponent("SyntheticVendor.app")
        components = folder.appendingPathComponent("components")
        try vendor(target)
        original = try treeDigest(target)
        try put("inert launcher", components.appendingPathComponent(launcherName))
        try put("// synthetic bootstrap", components.appendingPathComponent(bootstrapName))
        try plist(["CFBundleExecutable": "InertHelper"], components.appendingPathComponent(helperName + "/Contents/Info.plist"))
        builder = InjectionBuilder(components: components)
        builder.copy = { from, to in try fm.copyItem(at: from, to: to) }
        builder.sign = { _ in } // Signing identity is outside the transaction contract.
    }
    func engine(_ version: String = "fixture-1") throws -> InjectorEngine {
        let manifest = InjectorManifest(kind: packageKind, version: version, architecture: "arm64", bundleId: "com.ctrip.vbooking", minimumVendorVersion: "1.2.11", testedVendorVersions: ["1.2.11"], componentsSha256: try treeDigest(components))
        return try InjectorEngine(manifest: manifest, builder: builder, target: target, officialSignature: { _ in nil }, assertIdle: { [self] in
            idleCalls += 1; try idleAction?(idleCalls)
        })
    }
    func receipt(_ engine: InjectorEngine) throws -> Receipt { try readJSON(Receipt.self, engine.receiptURL) }
    func cleanJournal(_ engine: InjectorEngine) throws {
        try check(!exists(engine.pendingURL) && !exists(engine.previous) && !exists(engine.stage), "transaction leftovers")
    }
}

@main struct TransactionTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { try fail("temporary root required") }
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
        try check(root.deletingLastPathComponent() == fm.temporaryDirectory.resolvingSymlinksInPath() && root.lastPathComponent.hasPrefix("tsim-injector-transactions-"), "isolated temporary root required: \(root.path)")
        try lifecycle(root)
        try recovery(root)
        try failures(root)
        print("macos_injector_transaction_ok: real Swift engine/adapter, synthetic temporary bundles only; no installed app launched or accessed")
    }
    static func lifecycle(_ root: URL) throws {
        let f = try Fixture(root, "lifecycle"), e = try f.engine()
        try check(e.inspect().state == "compatible", "first install inspect")
        try e.install()
        let first = try f.receipt(e), firstDigest = try treeDigest(f.target)
        try check(first.state == "installed" && first.originalSha256 == f.original && first.installedSha256 == firstDigest, "first install receipt")
        try check(treeDigest(e.backup) == f.original && e.inspect().canRestore, "official backup retained")
        let receiptBytes = try Data(contentsOf: e.receiptURL)
        try e.install()
        try check(Data(contentsOf: e.receiptURL) == receiptBytes && treeDigest(f.target) == firstDigest, "repeat install is no-op")
        try put("// updated bootstrap", f.components.appendingPathComponent(bootstrapName))
        let updated = try f.engine("fixture-2"); try updated.install()
        try check(f.receipt(updated).version == "fixture-2" && treeDigest(f.target) != firstDigest && treeDigest(e.backup) == f.original, "update from original")
        try put("// synthetic bootstrap", f.components.appendingPathComponent(bootstrapName))
        let downgraded = try f.engine("fixture-1"); try downgraded.install()
        try check(f.receipt(downgraded).version == "fixture-1" && treeDigest(f.target) == firstDigest, "supported version rollback restores prior component build")
        try downgraded.restore()
        try check(treeDigest(f.target) == f.original && !exists(e.receiptURL) && !exists(e.backup), "restore byte-identical official tree")
        try f.cleanJournal(e)
        try e.install()
        try fm.removeItem(at: f.target); try vendor(f.target, "1.2.12")
        let replaced = try treeDigest(f.target)
        try check(e.inspect().state == "replaced", "official reinstall detected")
        try e.restore()
        try check(treeDigest(f.target) == replaced && !exists(e.receiptURL), "retire does not overwrite official reinstall")
        try e.install()
        try check(treeDigest(e.backup) == replaced, "reinject retains newly installed official version")
        try e.restore(); try check(treeDigest(f.target) == replaced, "new official version restored")
        print("PASS first install, repeat no-op, component/version update, version rollback, official reinstall/reinject, exact restore")
    }
    static func recovery(_ root: URL) throws {
        for phase in ["preparing", "install-moved", "install-committed", "update-moved", "restore-moved", "restore-committed", "retiring"] {
            let f = try Fixture(root, "recovery-" + phase), e = try f.engine()
            if phase == "preparing" {
                try e.withLock {
                    let journal = Receipt(target: f.target.path, originalSha256: f.original, installedSha256: "", version: "fixture-1", state: "preparing", hadInstalled: false)
                    try atomicJSON(journal, e.pendingURL)
                    try put("partial build", e.stage.appendingPathComponent("partial"))
                }
            } else {
                try e.install()
                var journal = try f.receipt(e)
                journal.state = phase.hasPrefix("restore") ? "restoring" : phase == "retiring" ? "retiring" : "installing"
                journal.hadInstalled = phase.hasPrefix("update") || phase.hasPrefix("restore")
                journal.previousSha256 = journal.hadInstalled ? journal.installedSha256 : nil
                if phase == "install-moved" {
                    try fm.moveItem(at: f.target, to: e.stage)
                } else if phase == "update-moved" || phase == "restore-moved" {
                    try fm.moveItem(at: f.target, to: e.previous)
                    try put("partial", e.stage.appendingPathComponent("partial"))
                    // A newer build is pending; rollback must use previousSha256 rather than the new build hash.
                    if phase == "update-moved" { journal.installedSha256 = String(repeating: "a", count: 64) }
                } else if phase == "restore-committed" {
                    try fm.moveItem(at: f.target, to: e.previous)
                    try fm.moveItem(at: e.backup, to: f.target)
                } else if phase == "retiring" {
                    journal.originalSha256 = try treeDigest(f.target)
                }
                try atomicJSON(journal, e.pendingURL)
                if phase == "install-committed" { try fm.removeItem(at: e.receiptURL) }
            }
            try check(e.inspect().state == "recovery", "interrupted state exposed: \(phase)")
            try e.withLock { try e.recover() }
            try f.cleanJournal(e)
            if ["preparing", "install-moved", "restore-committed"].contains(phase) {
                try check(treeDigest(f.target) == f.original, "original recovered: \(phase)")
            } else if phase == "retiring" {
                try check(!exists(e.receiptURL) && !exists(e.backup), "retirement completed")
            } else {
                try check(treeDigest(f.target) == f.receipt(e).installedSha256, "installed target recovered: \(phase)")
                try check(f.receipt(e).state == "installed", "committed receipt recovered")
            }
            // A recovered incomplete first install must be installable again.
            if phase == "preparing" || phase == "install-moved" { try e.install(); try e.restore() }
            print("PASS journal recovery \(phase)")
        }
    }
    static func failures(_ root: URL) throws {
        do {
            let f = try Fixture(root, "corrupt-backup"), e = try f.engine()
            try e.install()
            try put("corrupted", e.backup.appendingPathComponent("Contents/Info.plist"))
            let targetBefore = try treeDigest(f.target), backupBefore = try treeDigest(e.backup)
            try check(e.inspect().state == "blocked", "corrupt backup inspect")
            try rejects("备份已变化或缺失") { try e.install() }
            try rejects("备份已变化或缺失") { try e.restore() }
            try check(treeDigest(f.target) == targetBefore && treeDigest(e.backup) == backupBefore, "corrupt backup preserved")
            print("PASS backup corruption blocks install/restore and preserves both trees")
        }
        do {
            let f = try Fixture(root, "target-drift"), e = try f.engine()
            f.idleAction = { call in if call == 2 { try put("external update", f.target.appendingPathComponent("external-marker")) } }
            try rejects("发生变化") { try e.install() }
            let changed = try treeDigest(f.target)
            try check(changed != f.original && exists(e.pendingURL), "drift retained with journal")
            try rejects("中断事务无法自动恢复") { try e.withLock { try e.recover() } }
            try check(treeDigest(f.target) == changed && exists(e.stage), "recovery does not overwrite drift")
            print("PASS target drift during install and recovery is preserved")
        }
        do {
            let f = try Fixture(root, "restore-drift"), e = try f.engine()
            try e.install()
            let backupBefore = try treeDigest(e.backup)
            f.idleCalls = 0
            f.idleAction = { call in if call == 2 { try put("external update", f.target.appendingPathComponent("external-marker")) } }
            try rejects("发生变化") { try e.restore() }
            let targetBefore = try treeDigest(f.target)
            try rejects("中断事务无法自动恢复") { try e.withLock { try e.recover() } }
            try check(treeDigest(f.target) == targetBefore && treeDigest(e.backup) == backupBefore && exists(e.pendingURL), "restore drift preserves target and backup")
            print("PASS target drift during restore blocks overwrite and preserves backup")
        }
        do {
            let f = try Fixture(root, "recovery-corrupt-source"), e = try f.engine()
            try e.install()
            var journal = try f.receipt(e); journal.state = "installing"; journal.hadInstalled = true; journal.previousSha256 = journal.installedSha256
            try fm.moveItem(at: f.target, to: e.previous)
            try put("changed", e.previous.appendingPathComponent("marker"))
            try atomicJSON(journal, e.pendingURL)
            try rejects("恢复文件校验失败") { try e.withLock { try e.recover() } }
            try check(!exists(f.target) && exists(e.previous) && exists(e.pendingURL), "corrupt recovery source preserved")
            print("PASS recovery rejects corrupt previous source without discarding journal")
        }
        do {
            let f = try Fixture(root, "active-gate"), e = try f.engine()
            f.idleAction = { _ in try fail("synthetic active process") }
            try rejects("synthetic active process") { try e.install() }
            try rejects("synthetic active process") { try e.restore() }
            try check(!exists(e.store) && treeDigest(f.target) == f.original, "active gate before transaction")
            f.idleCalls = 0
            f.idleAction = { call in if call == 2 { try fail("synthetic became active") } }
            try rejects("synthetic became active") { try e.install() }
            try check(treeDigest(f.target) == f.original, "second idle gate before rename")
            try f.cleanJournal(e)
            print("PASS active process gate before transaction and immediately before replacement")
        }
        do {
            let f = try Fixture(root, "lock-gate"), e = try f.engine()
            try e.withLock {
                try rejects("另一个安装器") { try e.install() }
                try rejects("另一个安装器") { try e.restore() }
            }
            try check(treeDigest(f.target) == f.original && !exists(e.pendingURL), "contended lock prevents transaction")
            let lock = e.store.appendingPathComponent("lock")
            try fm.removeItem(at: lock)
            try fm.createSymbolicLink(at: lock, withDestinationURL: f.target.appendingPathComponent("Contents/Info.plist"))
            try rejects("无法打开安装锁") { try e.install() }
            try check(treeDigest(f.target) == f.original, "unsafe lock cannot write target")
            print("PASS exclusive lock contention and symlink lock rejection")
        }
        do {
            let f = try Fixture(root, "component-gate"), e = try f.engine()
            try put("tamper", f.components.appendingPathComponent(bootstrapName))
            try rejects("组件校验失败") { try e.install() }
            try check(treeDigest(f.target) == f.original && !exists(e.store), "component validation before transaction")
            print("PASS component integrity fails before target mutation")
        }
    }
}
