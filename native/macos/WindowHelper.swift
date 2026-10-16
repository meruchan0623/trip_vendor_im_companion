import AppKit
import ApplicationServices
import Foundation

// Thin macOS adapter: window metadata only; never reads window titles or content.
private let protocolVersion = "1.0"
private let bundleID = "com.ctrip.vbooking"
private var bound: [String: Any]?
private var generation = 0
private var observer: AXObserver?
private var observedApp: AXUIElement?
private var lastState = ""
private var hadCandidates = false
private let outputLock = NSLock()

private func emit(_ type: String, _ payload: Any, _ requestID: String? = nil) {
    var message: [String: Any] = ["protocolVersion": protocolVersion, "eventId": UUID().uuidString.lowercased(), "type": type, "accountScope": "unknown", "generation": generation, "payload": payload]
    message["targetInstanceId"] = bound?["targetInstanceId"] ?? NSNull()
    if let id = requestID { message["requestId"] = id }
    guard JSONSerialization.isValidJSONObject(message), var data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    data.append(10)
    outputLock.lock(); defer { outputLock.unlock() }
    // SIGPIPE is ignored: a closed stdout means the shell is gone.
    do { try FileHandle.standardOutput.write(contentsOf: data) } catch { exit(0) }
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

private func command(_ line: Data) {
    guard line.count <= 16384, let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          Set(value.keys).isSubset(of: ["protocolVersion", "requestId", "type", "payload"]),
          value["protocolVersion"] as? String == protocolVersion,
          let id = value["requestId"] as? String, !id.isEmpty, id.count <= 128,
          let type = value["type"] as? String else { emit("error", ["code": "invalid_command"]); return }
    let payload = value["payload"] as? [String: Any] ?? [:]
    guard Set(payload.keys).isSubset(of: ["targetInstanceId", "businessProbe"]) else { emit("error", ["code": "invalid_command"], id); return }
    switch type {
    case "listWindows": emit("windows", ["windows": windows()], id)
    case "bindWindow":
        guard let requested = payload["targetInstanceId"] as? String, let candidate = windows().first(where: { $0["targetInstanceId"] as? String == requested }), let pid = candidate["processId"] as? Int32 else { emit("error", ["code": "target_not_found"], id); return }
        bound = candidate; generation += 1; lastState = ""; hadCandidates = true; attachObserver(pid); updateWindow(id)
    case "unbindWindow": bound = nil; generation += 1; lastState = ""; detachObserver(); emit("windowState", ["bound": false, "reason": "unbound"], id)
    case "probeCapabilities": probe(id, business: payload["businessProbe"] as? Bool ?? false)
    case "stop": emit("stopped", [String: Any](), id); detachObserver(); exit(0)
    default: emit("error", ["code": "unsupported_command"], id)
    }
}

signal(SIGPIPE, SIG_IGN)
emit("capabilities", capability("not_bound"))
_ = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in if bound == nil { checkAvailability() } else { updateWindow() } }
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
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
