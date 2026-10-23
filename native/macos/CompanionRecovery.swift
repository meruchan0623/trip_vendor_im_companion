// Assistant-only recovery policy. The vendor process remains the owner of this
// generation; neither a surviving helper nor elapsed time proves a mounted panel.
struct CompanionRecovery {
    private(set) var retries = 0
    private(set) var nextLaunchAt: Double?
    private(set) var stopped = false
    private let delays: [Double] = [1, 3, 10]

    mutating func helperEnded(at now: Double, unexpected: Bool, ownerRunning: Bool) {
        guard !stopped, nextLaunchAt == nil else { return }
        guard ownerRunning, unexpected, retries < delays.count else { cancel(); return }
        nextLaunchAt = now + delays[retries]
    }

    mutating func shouldLaunch(at now: Double, ownerRunning: Bool) -> Bool {
        guard ownerRunning else { cancel(); return false }
        guard !stopped, let due = nextLaunchAt, now >= due else { return false }
        nextLaunchAt = nil
        retries += 1
        return true
    }

    mutating func cancel() { stopped = true; nextLaunchAt = nil }
}
