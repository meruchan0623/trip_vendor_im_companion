import AppKit
import ApplicationServices
import Foundation

// Merchant adapter reads window metadata only. Browser leases read only their own nonce/title protocol.
private let protocolVersion = "1.0"
private let bundleID = "com.ctrip.vbooking"
private var bound: [String: Any]?
private var generation = 0
private var observer: AXObserver?
private var observedApp: AXUIElement?
private var lastState = ""
private var hadCandidates = false
private let outputLock = NSLock()
private var outputClosed = false

private func emit(_ type: String, _ payload: Any, _ requestID: String? = nil) {
    guard !outputClosed else { return }
    var message: [String: Any] = ["protocolVersion": protocolVersion, "eventId": UUID().uuidString.lowercased(), "type": type, "accountScope": "unknown", "generation": generation, "payload": payload]
    message["targetInstanceId"] = bound?["targetInstanceId"] ?? NSNull()
    if let id = requestID { message["requestId"] = id }
    guard JSONSerialization.isValidJSONObject(message), var data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    data.append(10)
    outputLock.lock(); defer { outputLock.unlock() }
    // SIGPIPE is ignored: a closed stdout means the shell is gone.
    do { try FileHandle.standardOutput.write(contentsOf: data) } catch { outputClosed = true; beginProfileShutdown() }
}

private func startMillis(_ app: NSRunningApplication) -> Int64? {
    if let launched = app.launchDate { return Int64((launched.timeIntervalSince1970 * 1000).rounded(.down)) }
    // Only processes started outside LaunchServices lack launchDate; kernel start time is equally stable.
    var info = kinfo_proc(); var size = MemoryLayout<kinfo_proc>.stride; var mib = [CTL_KERN, KERN_PROC, KERN_PROC_PID, app.processIdentifier]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    return Int64(start.tv_sec) * 1000 + Int64(start.tv_usec) / 1000
}

private func instanceID(_ app: NSRunningApplication, _ number: Int) -> String? { startMillis(app).map { "\(app.processIdentifier):\($0):\(number)" } }

private func windows() -> [[String: Any]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    let found: [(item: [String: Any], active: Bool, area: CGFloat, order: Int)] = list.enumerated().compactMap { order, item in
        // Tooltips and notifier popups are small; the main window hosts the IM view.
        guard let pid = item[kCGWindowOwnerPID as String] as? Int32, item[kCGWindowLayer as String] as? Int == 0,
              let number = item[kCGWindowNumber as String] as? Int, (item[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let raw = item[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary),
              rect.width >= 400, rect.height >= 300,
              let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleID, let id = instanceID(app, number) else { return nil }
        return (["targetInstanceId": id, "handle": number, "processId": pid, "displayName": "旅游商家桌面版"], app.isActive, rect.width * rect.height, order)
    }
    return found.sorted { $0.active != $1.active ? $0.active : $0.area != $1.area ? $0.area > $1.area : $0.order < $1.order }.map(\.item)
}

private func dpi(_ rect: CGRect) -> Int {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16); var count: UInt32 = 0
    guard CGGetDisplaysWithRect(rect, 16, &ids, &count) == .success else { return 72 }
    let overlap = { (id: CGDirectDisplayID) -> CGFloat in let r = CGDisplayBounds(id).intersection(rect); return r.isNull ? 0 : r.width * r.height }
    // Mode pixel/point ratio is the live backingScaleFactor without NSApplication screen caching.
    guard let display = ids.prefix(Int(count)).max(by: { overlap($0) < overlap($1) }), let mode = CGDisplayCopyDisplayMode(display), mode.width > 0 else { return 72 }
    let scale = Double(mode.pixelWidth) / Double(mode.width)
    return scale.isFinite && scale > 0 && scale <= 8 ? Int((scale * 72).rounded()) : 72
}

private func capability(_ reason: String, nodes: Int? = nil) -> [String: Any] {
    var result: [String: Any] = ["windowFollow": true, "readMessage": false, "readOrder": false, "readDraft": false, "writeDraft": false, "reason": reason, "accessibilityTrusted": AXIsProcessTrusted(), "platformAcceptance": "requires_real_mac"]
    if let count = nodes { result["probe"] = ["nodeCount": count, "contentRead": false, "stableIdentity": false, "imeObservable": false] }
    return result
}

private func detachObserver() {
    if let existing = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(existing), .commonModes) }
    observer = nil; observedApp = nil
}

private func attachObserver(_ pid: pid_t) {
    detachObserver()
    // Window following does not request Accessibility or Screen Recording permission.
    guard AXIsProcessTrusted() else { return }
    var value: AXObserver?
    let code = AXObserverCreate(pid, { _, _, _, _ in updateWindow() }, &value)
    guard code == .success, let value else { return }
    observer = value
    let app = AXUIElementCreateApplication(pid); observedApp = app
    for notification in [kAXWindowCreatedNotification, kAXFocusedWindowChangedNotification, kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification] {
        AXObserverAddNotification(value, app, notification as CFString, nil)
    }
    var raw: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success, let appWindows = raw as? [AXUIElement] {
        for window in appWindows {
            for notification in [kAXMovedNotification, kAXResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification, kAXUIElementDestroyedNotification] {
                AXObserverAddNotification(value, window, notification as CFString, nil)
            }
        }
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(value), .commonModes)
}

private func lose(_ requestID: String?) {
    // Another candidate may exist; the shell decides whether to rebind.
    generation += 1; emit("windowState", ["bound": false, "targetLost": true, "reason": "target_lost"], requestID); bound = nil; lastState = ""; detachObserver()
}

private func describe(_ windowID: Int) -> [[String: Any]]? {
    // Unlike .optionIncludingWindow, this still describes minimized, hidden and other-Space windows; only destroyed ones are absent.
    var ids: [UnsafeRawPointer?] = [UnsafeRawPointer(bitPattern: UInt(CGWindowID(windowID)))]
    return CFArrayCreate(nil, &ids, 1, nil).flatMap { CGWindowListCreateDescriptionFromArray($0) } as? [[String: Any]]
}

private func updateWindow(_ requestID: String? = nil) {
    guard let selected = bound, let windowID = selected["handle"] as? Int, let pid = selected["processId"] as? Int32 else { return }
    // Identity includes launch time, so PID reuse cannot silently rebind.
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleID,
          selected["targetInstanceId"] as? String == instanceID(app, windowID),
          let list = describe(windowID),
          let entry = list.first(where: { $0[kCGWindowNumber as String] as? Int == windowID && $0[kCGWindowOwnerPID as String] as? Int32 == pid }),
          let rawBounds = entry[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else { lose(requestID); return }
    guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy({ $0.isFinite }), rect.width > 0, rect.height > 0 else {
        if let id = requestID { bound = nil; generation += 1; detachObserver(); emit("error", ["code": "target_not_found"], id) }
        return
    }
    let onscreen = entry[kCGWindowIsOnscreen as String] as? Bool ?? false
    let state: [String: Any] = ["bound": true, "bounds": ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height], "visible": onscreen, "minimized": !onscreen, "foreground": app.isActive, "groupForeground": app.isActive, "dpi": dpi(rect), "coordinateSpace": "screen-points-top-left", "boundsSource": "cgWindow"]
    guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), let key = String(data: data, encoding: .utf8) else { return }
    if requestID == nil && key == lastState { return }
    lastState = key; emit("windowState", state, requestID)
}

private func checkAvailability() {
    // Availability is a hint only; bindWindow re-enumerates and proves identity.
    let available = !windows().isEmpty
    if available && !hadCandidates { emit("targetAvailable", [String: Any]()) }
    hadCandidates = available
}

private func probe(_ requestID: String, business: Bool) {
    guard business else { emit("capabilities", capability(bound == nil ? "not_bound" : "identity_and_revision_unverified"), requestID); return }
    // Explicit probe still only checks existing trust. UI permission requests are a separate user action.
    guard AXIsProcessTrusted() else { emit("capabilities", capability("accessibility_permission_required"), requestID); return }
    guard let pid = bound?["processId"] as? Int32 else { emit("capabilities", capability("not_bound"), requestID); return }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var queue = [app]; var nodes = 0; let start = Date()
    while !queue.isEmpty && nodes < 200 && Date().timeIntervalSince(start) < 1.5 {
        let element = queue.removeFirst(); nodes += 1
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success, let values = children as? [AXUIElement] { queue.append(contentsOf: values.prefix(max(0, 200 - nodes - queue.count))) }
    }
    emit("capabilities", capability("identity_and_revision_unverified", nodes: nodes), requestID)
}

// A browser process can be shared with the user's tabs. Ownership is always an
// exact new AX window, pinned to executable + PID + launch time, never the process.
private struct BrowserWindowPin {
    let element: AXUIElement
    let pid: pid_t
    let started: Int64
}
private final class ProfileLease {
    let id: String, executable: URL
    let before: [BrowserWindowPin]
    var owned: [BrowserWindowPin] = []
    var claimed = false, cancelled = false, placed = false, shown = false, closeReported = false
    var heartbeat = Date(), expires = Date().addingTimeInterval(60)
    init(_ id: String, _ executable: URL, _ before: [BrowserWindowPin]) { self.id = id; self.executable = executable; self.before = before }
}
private var profileLeases: [String: ProfileLease] = [:]
private var activeProfileLease: String?
private var profileShutdownDeadline: Date?
private let uuidPattern = "^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$"
private func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
private func exactKeys(_ value: [String: Any], _ keys: [String]) -> Bool { Set(value.keys) == Set(keys) }
private func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
private func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
private func canonical(_ url: URL) -> URL { url.standardizedFileURL.resolvingSymlinksInPath() }
private func profileExecutable(_ kind: String) -> URL? {
    guard ["chrome", "edge"].contains(kind) else { return nil }
    let product = kind == "edge" ? "Microsoft Edge" : "Google Chrome"
    for root in [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")] {
        let executable = root.appendingPathComponent("\(product).app/Contents/MacOS/\(product)")
        if FileManager.default.isExecutableFile(atPath: executable.path) { return canonical(executable) }
    }
    return nil
}
private func browserWindows(_ executable: URL) -> [BrowserWindowPin] {
    var result: [BrowserWindowPin] = []
    for app in NSWorkspace.shared.runningApplications {
        guard let image = app.executableURL, canonical(image) == executable, let started = startMillis(app) else { continue }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.3)
        guard let values = axValue(element, kAXWindowsAttribute) as? [AXUIElement] else { continue }
        for window in values.prefix(100) { AXUIElementSetMessagingTimeout(window, 0.3); result.append(BrowserWindowPin(element: window, pid: app.processIdentifier, started: started)) }
    }
    return result
}
private func sameWindow(_ lhs: BrowserWindowPin, _ rhs: BrowserWindowPin) -> Bool { lhs.pid == rhs.pid && lhs.started == rhs.started && CFEqual(lhs.element, rhs.element) }
private enum BrowserPresence: Equatable { case present, gone, unverified }
private func presence(_ pin: BrowserWindowPin, _ lease: ProfileLease) -> BrowserPresence {
    guard let app = NSRunningApplication(processIdentifier: pin.pid) else { return kill(pin.pid, 0) == -1 && errno == ESRCH ? .gone : .unverified }
    if app.isTerminated { return .gone }
    guard let image = app.executableURL, let started = startMillis(app) else { return .unverified }
    if canonical(image) != lease.executable || started != pin.started { return .gone }
    let appElement = AXUIElementCreateApplication(pin.pid); AXUIElementSetMessagingTimeout(appElement, 0.3)
    guard let windows = axValue(appElement, kAXWindowsAttribute) as? [AXUIElement] else { return .unverified }
    return windows.contains { CFEqual($0, pin.element) } ? .present : .gone
}
private func pinned(_ pin: BrowserWindowPin, _ lease: ProfileLease) -> Bool { presence(pin, lease) == .present }
private func newProfileWindows(_ lease: ProfileLease) -> [BrowserWindowPin] {
    browserWindows(lease.executable).filter { pin in
        guard !lease.before.contains(where: { sameWindow($0, pin) }) else { return false }
        let title = axValue(pin.element, kAXTitleAttribute) as? String ?? ""
        let expected = "TSim Companion Bootstrap \(lease.id)"
        return [expected, expected + " - Google Chrome", expected + " - Microsoft Edge"].contains(title)
    }
}
private func collectAndCloseProfile(_ lease: ProfileLease) {
    for pin in newProfileWindows(lease) where !lease.owned.contains(where: { sameWindow($0, pin) }) { lease.owned.append(pin); lease.claimed = true }
    for pin in lease.owned where pinned(pin, lease) {
        // Never activate, hide, quit or kill the shared browser application.
        if let button = axElement(axValue(pin.element, kAXCloseButtonAttribute)) { _ = AXUIElementPerformAction(button, kAXPressAction as CFString) }
    }
}
private func profileComplete(_ lease: ProfileLease) -> Bool { lease.claimed && lease.owned.allSatisfy { presence($0, lease) == .gone } }
private func launchProfile(_ payload: [String: Any], _ requestID: String) {
    guard AXIsProcessTrusted() else { emit("error", ["code": "browser_accessibility_required"], requestID); return }
    guard exactKeys(payload, ["launchId", "browserKind", "profileDirectory", "bootstrapURL"]),
          let id = payload["launchId"] as? String, matches(id, uuidPattern), profileLeases[id] == nil, profileLeases.count < 32, profileShutdownDeadline == nil,
          let kind = payload["browserKind"] as? String, let executable = profileExecutable(kind),
          let directory = payload["profileDirectory"] as? String, matches(directory, "^(?:Default|Profile [1-9][0-9]*)$"),
          let value = payload["bootstrapURL"] as? String, let url = URLComponents(string: value), url.scheme == "http", url.host == "127.0.0.1", (url.port ?? 0) > 0,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path == "/bootstrap/\(id)" else { emit("error", ["code": "browser_profile_denied"], requestID); return }
    let parts = kind == "edge" ? "Microsoft Edge" : "Google/Chrome"
    let data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/\(parts)")
    let profile = data.appendingPathComponent(directory)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: profile.path, isDirectory: &isDirectory), isDirectory.boolValue,
          profile.standardizedFileURL == canonical(profile), data.standardizedFileURL == canonical(data) else { emit("error", ["code": "browser_profile_denied"], requestID); return }
    let lease = ProfileLease(id, executable, browserWindows(executable)); profileLeases[id] = lease
    let process = Process(); process.executableURL = executable
    process.arguments = ["--user-data-dir=\(data.path)", "--profile-directory=\(directory)", "--no-first-run", "--no-default-browser-check", "--app=\(value)", "--window-position=-32000,-32000", "--window-size=800,600"]
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
    do { try process.run(); emit("profileBrowserLaunched", ["launchId": id], requestID) }
    catch { lease.cancelled = true; emit("error", ["code": "browser_launch_failed"], requestID) }
}
private func profileCommand(_ type: String, _ payload: [String: Any], _ requestID: String) {
    if type == "launchProfileBrowser" { launchProfile(payload, requestID); return }
    if type == "placeBrowser" {
        guard Set(payload.keys).isSubset(of: ["bounds", "visible", "restack", "maximized"]), let id = activeProfileLease, let lease = profileLeases[id], !lease.cancelled,
              let pin = lease.owned.first, pinned(pin, lease), let rect = payload["bounds"] as? [String: Any], exactKeys(rect, ["x", "y", "width", "height"]),
              let x = rect["x"] as? Double, let y = rect["y"] as? Double, let width = rect["width"] as? Double, let height = rect["height"] as? Double,
              [x,y,width,height].allSatisfy({ $0.isFinite }), abs(x) < 100000, abs(y) < 100000, width > 0, height > 0, width <= 20000, height <= 20000,
              let visible = payload["visible"] as? Bool else { emit("error", ["code": "browser_placement_failed"], requestID); return }
        if !lease.placed {
            var position = CGPoint(x: x, y: y), size = CGSize(width: width, height: height)
            guard let point = AXValueCreate(.cgPoint, &position), let dimensions = AXValueCreate(.cgSize, &size),
                  AXUIElementSetAttributeValue(pin.element, kAXPositionAttribute as CFString, point) == .success,
                  AXUIElementSetAttributeValue(pin.element, kAXSizeAttribute as CFString, dimensions) == .success,
                  AXUIElementSetAttributeValue(pin.element, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success else { emit("error", ["code": "browser_placement_failed"], requestID); return }
            lease.placed = true
        }
        if visible && !lease.shown {
            guard AXUIElementSetAttributeValue(pin.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success else { emit("error", ["code": "browser_placement_failed"], requestID); return }
            _ = AXUIElementPerformAction(pin.element, kAXRaiseAction as CFString)
            NSRunningApplication(processIdentifier: pin.pid)?.activate(options: [.activateIgnoringOtherApps]); lease.shown = true
        }
        emit("browserPlaced", ["visible": visible, "bounds": rect], requestID); return
    }
    guard exactKeys(payload, ["launchId"]), let id = payload["launchId"] as? String, matches(id, uuidPattern), let lease = profileLeases[id] else { emit("error", ["code": "browser_lease_unknown"], requestID); return }
    if type == "cleanupProfileBrowser" { lease.cancelled = true; lease.expires = Date().addingTimeInterval(60); collectAndCloseProfile(lease); if activeProfileLease == id { activeProfileLease = nil }; emit("profileBrowserCleaned", ["complete": profileComplete(lease)], requestID); return }
    guard !lease.cancelled else { emit("error", ["code": "browser_lease_unknown"], requestID); return }
    if type == "heartbeatProfileBrowser" { lease.heartbeat = Date(); emit("profileBrowserHeartbeat", [String: Any](), requestID); return }
    let candidates = newProfileWindows(lease)
    guard candidates.count == 1 else { emit("error", ["code": candidates.isEmpty ? "browser_window_pending" : "browser_window_ambiguous"], requestID); return }
    guard !lease.claimed, pinned(candidates[0], lease) else { emit("error", ["code": "browser_identity_unverified"], requestID); return }
    lease.owned = candidates; lease.claimed = true; lease.heartbeat = Date(); activeProfileLease = id
    emit("profileBrowserAdopted", ["launchId": id], requestID)
}
private func checkProfileLeases() {
    let now = Date()
    for (id, lease) in Array(profileLeases) {
        if !lease.cancelled && now.timeIntervalSince(lease.heartbeat) > 12 { lease.cancelled = true; lease.expires = now.addingTimeInterval(60) }
        if lease.cancelled { collectAndCloseProfile(lease); if now >= lease.expires && (!lease.claimed || profileComplete(lease)) { profileLeases.removeValue(forKey: id) }; continue }
        guard activeProfileLease == id, let pin = lease.owned.first else { continue }
        let state = presence(pin, lease)
        if state == .gone { activeProfileLease = nil; lease.cancelled = true; emit("browserLost", [String: Any]()); continue }
        if state == .unverified { continue }
        guard !lease.closeReported, let title = axValue(pin.element, kAXTitleAttribute) as? String, title.utf8.count <= 768 else { continue }
        var protocolTitle = title
        for suffix in [" - Google Chrome", " - Microsoft Edge"] where protocolTitle.hasSuffix(suffix) { protocolTitle = String(protocolTitle.dropLast(suffix.count)) }
        let prefix = "TSim Companion Geometry \(id) "
        guard protocolTitle.hasPrefix(prefix), let data = String(protocolTitle.dropFirst(prefix.count)).data(using: .utf8),
              let geometry = try? JSONSerialization.jsonObject(with: data) as? [String: Any], exactKeys(geometry, ["v", "viewport", "rect", "closed"]),
              geometry["v"] as? Int == 1, geometry["closed"] as? Bool == true, geometry["rect"] is NSNull else { continue }
        lease.closeReported = true; emit("browserComponentGeometry", ["launchId": id, "closed": true, "rect": NSNull()])
    }
    if let deadline = profileShutdownDeadline, now >= deadline || profileLeases.values.allSatisfy({ profileComplete($0) }) { exit(0) }
}
private func beginProfileShutdown() {
    if profileLeases.isEmpty { exit(0) }
    if profileShutdownDeadline == nil { profileShutdownDeadline = Date().addingTimeInterval(12) }
    for lease in profileLeases.values { lease.cancelled = true; collectAndCloseProfile(lease) }
    detachObserver(); checkProfileLeases()
}

private func command(_ line: Data) {
    guard line.count <= 16384, let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          Set(value.keys).isSubset(of: ["protocolVersion", "requestId", "type", "payload"]),
          value["protocolVersion"] as? String == protocolVersion,
          let id = value["requestId"] as? String, !id.isEmpty, id.count <= 128,
          let type = value["type"] as? String else { emit("error", ["code": "invalid_command"]); return }
    let payload = value["payload"] as? [String: Any] ?? [:]
    if ["launchProfileBrowser", "adoptProfileBrowser", "cleanupProfileBrowser", "heartbeatProfileBrowser", "placeBrowser"].contains(type) { profileCommand(type, payload, id); return }
    guard Set(payload.keys).isSubset(of: ["targetInstanceId", "businessProbe"]) else { emit("error", ["code": "invalid_command"], id); return }
    switch type {
    case "listWindows": emit("windows", ["windows": windows()], id)
    case "bindWindow":
        guard let requested = payload["targetInstanceId"] as? String, let candidate = windows().first(where: { $0["targetInstanceId"] as? String == requested }), let pid = candidate["processId"] as? Int32 else { emit("error", ["code": "target_not_found"], id); return }
        bound = candidate; generation += 1; lastState = ""; hadCandidates = true; attachObserver(pid); updateWindow(id)
    case "unbindWindow": bound = nil; generation += 1; lastState = ""; detachObserver(); emit("windowState", ["bound": false, "reason": "unbound"], id)
    case "probeCapabilities": probe(id, business: payload["businessProbe"] as? Bool ?? false)
    case "stop": emit("stopped", [String: Any](), id); beginProfileShutdown()
    default: emit("error", ["code": "unsupported_command"], id)
    }
}

signal(SIGPIPE, SIG_IGN)
emit("capabilities", capability("not_bound"))
_ = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in checkProfileLeases(); if bound == nil { checkAvailability() } else { updateWindow() } }
DispatchQueue.global().async {
    var pending = Data(); var oversized = false; var buffer = [UInt8](repeating: 0, count: 1024)
    // FileHandle.read(upToCount:) waits for a full chunk on pipes; read(2) returns each line as it arrives.
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { break }
        for byte in buffer.prefix(count) {
            if byte == 10 {
                let line = pending; let rejected = oversized; pending.removeAll(keepingCapacity: true); oversized = false
                DispatchQueue.main.async { if rejected { emit("error", ["code": "message_too_large"]) } else { command(line) } }
            } else if !oversized && byte != 13 { if pending.count >= 16384 { oversized = true; pending.removeAll() } else { pending.append(byte) } }
        }
    }
    // EOF: queued commands run first, then a clean exit.
    DispatchQueue.main.async { beginProfileShutdown() }
}
RunLoop.main.run()
