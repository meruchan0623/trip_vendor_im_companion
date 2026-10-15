import AppKit
import ApplicationServices
import Foundation

// Thin macOS adapter. Build and verify on a real Mac; Windows cannot validate AX behavior.
private let protocolVersion = "1.0"
private let bundleID = "com.ctrip.vbooking"
private var bound: [String: Any]?
private var generation = 0
private var observer: AXObserver?
private var observedApp: AXUIElement?
private var lastState = ""
private let outputLock = NSLock()

private func emit(_ type: String, _ payload: Any, _ requestID: String? = nil) {
    var message: [String: Any] = ["protocolVersion": protocolVersion, "eventId": UUID().uuidString.lowercased(), "type": type, "accountScope": "unknown", "generation": generation, "payload": payload]
    message["targetInstanceId"] = bound?["targetInstanceId"] ?? NSNull()
    if let id = requestID { message["requestId"] = id }
    guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}

private func windows() -> [[String: Any]] {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { item in
        guard let pid = item[kCGWindowOwnerPID as String] as? Int32,
              let app = apps.first(where: { $0.processIdentifier == pid }),
              let number = item[kCGWindowNumber as String] as? Int,
              item[kCGWindowLayer as String] as? Int == 0,
              let launched = app.launchDate else { return nil }
        return ["targetInstanceId": "\(pid):\(launched.timeIntervalSince1970):\(number)", "handle": number, "processId": pid, "displayName": "旅游商家桌面版"]
    }
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

private func updateWindow(_ requestID: String? = nil) {
    guard let selected = bound, let windowID = selected["handle"] as? Int, let pid = selected["processId"] as? Int32 else { return }
    let app = NSRunningApplication(processIdentifier: pid)
    // Identity includes launch date, so PID reuse cannot silently rebind.
    guard let app, app.bundleIdentifier == bundleID, let launched = app.launchDate,
          selected["targetInstanceId"] as? String == "\(pid):\(launched.timeIntervalSince1970):\(windowID)" else {
        generation += 1; emit("windowState", ["bound": false, "targetLost": true, "reason": "target_lost"], requestID); bound = nil; detachObserver(); return
    }
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowID)) as? [[String: Any]],
          let entry = list.first(where: { $0[kCGWindowNumber as String] as? Int == windowID }),
          let rawBounds = entry[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else {
        generation += 1; emit("windowState", ["bound": false, "targetLost": true, "reason": "target_lost"], requestID); bound = nil; detachObserver(); return
    }
    let state: [String: Any] = ["bound": true, "bounds": ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height], "visible": entry[kCGWindowIsOnscreen as String] as? Bool ?? false, "minimized": !(entry[kCGWindowIsOnscreen as String] as? Bool ?? false), "foreground": app.isActive, "dpi": 72, "coordinateSpace": "screen-points-top-left", "boundsSource": "cgWindow"]
    guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), let key = String(data: data, encoding: .utf8) else { return }
    if requestID == nil && key == lastState { return }
    lastState = key; emit("windowState", state, requestID)
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
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success, let values = children as? [AXUIElement] { queue.append(contentsOf: values.prefix(200 - nodes - queue.count)) }
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
        guard let requested = payload["targetInstanceId"] as? String, let candidate = windows().first(where: { $0["targetInstanceId"] as? String == requested }) else { emit("error", ["code": "target_not_found"], id); return }
        bound = candidate; generation += 1; lastState = ""; attachObserver(candidate["processId"] as! pid_t); updateWindow(id)
    case "unbindWindow": bound = nil; generation += 1; detachObserver(); emit("windowState", ["bound": false, "reason": "unbound"], id)
    case "probeCapabilities": probe(id, business: payload["businessProbe"] as? Bool ?? false)
    case "stop": emit("stopped", [:], id); exit(0)
    default: emit("error", ["code": "unsupported_command"], id)
    }
}

emit("capabilities", capability("not_bound"))
let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in updateWindow() }
DispatchQueue.global().async {
    var pending = Data(); var oversized = false
    while let chunk = try? FileHandle.standardInput.read(upToCount: 1024), !chunk.isEmpty {
        for byte in chunk {
            if byte == 10 {
                let line = pending; let rejected = oversized; pending.removeAll(keepingCapacity: true); oversized = false
                DispatchQueue.main.async { if rejected { emit("error", ["code": "message_too_large"]) } else { command(line) } }
            } else if !oversized { if pending.count >= 16384 { oversized = true; pending.removeAll() } else { pending.append(byte) } }
        }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
