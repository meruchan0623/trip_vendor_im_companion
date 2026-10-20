import AppKit
import UniformTypeIdentifiers

func resources() -> URL { Bundle.main.resourceURL! }
func loadManifest() throws -> InjectorManifest {
    let root = resources(), file = root.appendingPathComponent("manifest.json")
    guard sha(try Data(contentsOf: file)) == InstallerConfiguration.manifestSha256 else { try fail("安装清单校验失败，请重新获取安装器") }
    return try readJSON(InjectorManifest.self, file)
}
func loadEngine(_ target: String) throws -> InjectorEngine {
    try InjectorEngine(manifest: loadManifest(), payload: resources().appendingPathComponent("payload.app"), target: URL(fileURLWithPath: target))
}
func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
func appleQuote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r") + "\""
}

final class InstallerApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let target = NSTextField(string: "/Applications/旅游商家桌面版.app")
    let status = NSTextField(wrappingLabelWithString: "选择官方客户端并检查。安装前请手动完全退出客户端、助手和官方更新程序。")
    let log = NSTextView()
    let select = NSButton(title: "选择客户端…", target: nil, action: nil)
    let check = NSButton(title: "检查状态", target: nil, action: nil)
    let install = NSButton(title: "安装 / 更新助手", target: nil, action: nil)
    let restore = NSButton(title: "卸载并恢复原版", target: nil, action: nil)
    let progress = NSProgressIndicator()
    var busy = false
    var checkedTarget: String?
    var lastInspection: Inspection?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu(), item = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出安装器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 700), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "旅游商家助手 · macOS 一次性注入"; window.delegate = self; window.center()
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 16; body.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(body)
        NSLayoutConstraint.activate([body.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 26), body.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -26), body.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24), body.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24)])
        let title = NSTextField(labelWithString: "一次安装，之后照常打开旅游商家桌面版")
        title.font = .systemFont(ofSize: 21, weight: .semibold); body.addArrangedSubview(title)
        let intro = NSTextField(wrappingLabelWithString: "macOS 版在助手内登录 TSIM 账号。安装器仅在你点击安装或恢复时运行，完成后可退出。")
        intro.textColor = .secondaryLabelColor; body.addArrangedSubview(intro)
        let row = NSStackView(views: [target, select]); row.orientation = .horizontal; row.spacing = 10
        target.isEditable = false; target.isSelectable = true; target.lineBreakMode = .byTruncatingMiddle
        target.setContentHuggingPriority(.defaultLow, for: .horizontal)
        select.target = self; select.action = #selector(choose); body.addArrangedSubview(row)
        let controls = NSStackView(views: [check, install, restore, progress]); controls.orientation = .horizontal; controls.spacing = 12
        check.target = self; check.action = #selector(checkAction)
        install.target = self; install.action = #selector(installAction); install.bezelStyle = .rounded
        restore.target = self; restore.action = #selector(restoreAction)
        progress.style = .spinning; progress.controlSize = .small; progress.isDisplayedWhenStopped = false
        body.addArrangedSubview(controls)
        status.font = .systemFont(ofSize: 13, weight: .medium); body.addArrangedSubview(status)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        log.isEditable = false; log.isSelectable = true; log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        log.autoresizingMask = [.width]; log.textContainer?.widthTracksTextView = true; scroll.documentView = log
        body.addArrangedSubview(scroll)
        let note = NSTextField(wrappingLabelWithString: "版本、官方签名和完整文件校验通过后才可注入。安装器保留官方原件和收据；更新与卸载会检查文件变化。官方已升级时会停止，请重新安装对应官方原版。")
        note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; body.addArrangedSubview(note)
        for view in [intro, row, controls, status, scroll, note] { view.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true }
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        append("安装器版本：\(InstallerConfiguration.version)\n支持的官方版本：\(InstallerConfiguration.vendorVersion) / Apple Silicon Mac\n请先点击检查状态。")
        updateButtons(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func append(_ value: String) { log.string += value + "\n"; log.scrollToEndOfDocument(nil) }
    func updateButtons() {
        select.isEnabled = !busy; check.isEnabled = !busy
        install.isEnabled = !busy && checkedTarget == target.stringValue && lastInspection?.canInstall == true
        restore.isEnabled = !busy && checkedTarget == target.stringValue && lastInspection?.canRestore == true
    }
    @objc func choose() {
        let panel = NSOpenPanel(); panel.title = "选择官方旅游商家桌面版.app"; panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowedContentTypes = [.applicationBundle]; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            target.stringValue = url.path; checkedTarget = nil; lastInspection = nil; updateButtons()
            if url.path != "/Applications/旅游商家桌面版.app" { status.stringValue = "本版仅支持应用程序目录的官方客户端：/Applications/旅游商家桌面版.app"; append(status.stringValue); return }
            perform("check")
        }
    }
    @objc func checkAction() { perform("check") }
    @objc func installAction() { confirm("安装 / 更新助手", "请确认已手动完全退出客户端、助手和更新程序。将备份官方原件，并在此客户端中注入助手。", "install") }
    @objc func restoreAction() { confirm("卸载并恢复官方原版", "请确认已手动完全退出客户端、助手和更新程序。将检查收据并恢复备份的官方应用，账号与客户数据保留。", "restore") }
    func confirm(_ title: String, _ message: String, _ operation: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message + "\n\n" + target.stringValue
        let proceed = alert.addButton(withTitle: "继续"), cancel = alert.addButton(withTitle: "取消")
        proceed.keyEquivalent = ""; cancel.keyEquivalent = "\r"
        if alert.runModal() == .alertFirstButtonReturn { perform(operation) }
    }
    func needsPrivileges(_ path: String) -> Bool {
        let url = URL(fileURLWithPath: path), parent = url.deletingLastPathComponent()
        if !fm.isWritableFile(atPath: parent.path) { return true }
        let store = parent.appendingPathComponent(".tsim-injector-" + String(sha(Data(path.utf8)).prefix(20)))
        if exists(store), let attrs = try? fm.attributesOfItem(atPath: store.path), let owner = attrs[.ownerAccountID] as? NSNumber { return owner.uint32Value != geteuid() }
        return false
    }
    func perform(_ operation: String) {
        guard !busy else { return }
        busy = true; updateButtons(); progress.startAnimation(nil)
        let selected = target.stringValue, executable = Bundle.main.executablePath!, elevated = needsPrivileges(target.stringValue)
        status.stringValue = operation == "check" ? "正在检查版本、签名和文件…" : "正在执行操作，请保持安装器打开…"
        append("\n[\(operation)] \(selected)\(elevated ? "（需要管理员权限）" : "")")
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let args = ["--engine", operation, "--target", selected]
                let output: String
                if elevated {
                    let command = ([executable] + args).map(shellQuote).joined(separator: " ")
                    output = try run("/usr/bin/osascript", ["-e", "do shell script \(appleQuote(command)) with prompt \(appleQuote("安装旅游商家助手：检查、注入或恢复官方客户端")) with administrator privileges"])
                } else { output = try run(executable, args) }
                let inspection = operation == "check" ? try JSONDecoder().decode(Inspection.self, from: Data(output.utf8)) : nil
                DispatchQueue.main.async {
                    self.append(output); self.busy = false; self.progress.stopAnimation(nil)
                    if let inspection { self.lastInspection = inspection; self.checkedTarget = selected; self.status.stringValue = inspection.message }
                    else { self.checkedTarget = nil; self.lastInspection = nil; self.status.stringValue = "操作完成。点击检查状态可确认结果。" }
                    self.updateButtons()
                }
            } catch {
                let text = String(describing: error)
                DispatchQueue.main.async {
                    self.append("失败：" + text); self.status.stringValue = "操作未完成，详细原因见下方日志。"
                    self.busy = false; self.progress.stopAnimation(nil); self.checkedTarget = nil; self.lastInspection = nil; self.updateButtons()
                }
            }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if busy { NSSound.beep(); return false }; NSApp.terminate(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { if busy { NSSound.beep(); return .terminateCancel }; return .terminateNow }
}

@main struct Main {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if !args.isEmpty {
            do {
                if args == ["--verify-package"] {
                    let manifest = try loadManifest(), payload = resources().appendingPathComponent("payload.app")
                    guard try treeDigest(payload) == manifest.payloadSha256 else { try fail("安装载荷校验失败") }
                    _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", payload.path])
                    print(String(decoding: try JSONEncoder().encode(manifest), as: UTF8.self)); return
                }
                guard args.count == 4, args[0] == "--engine", ["check", "install", "restore"].contains(args[1]), args[2] == "--target" else { try fail("参数无效") }
                let engine = try loadEngine(args[3])
                switch args[1] {
                case "check":
                    let data = try JSONEncoder().encode(engine.inspect()); print(String(decoding: data, as: UTF8.self))
                case "install": try engine.install()
                case "restore": try engine.restore()
                default: break
                }
            } catch { fputs("\(error)\n", stderr); exit(1) }
        } else {
            let app = NSApplication.shared, delegate = InstallerApp(); app.delegate = delegate; app.run()
        }
    }
}
