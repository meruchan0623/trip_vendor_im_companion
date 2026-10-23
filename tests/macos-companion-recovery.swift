// Pure recovery policy test: no AppKit, official app, windows or account access.
var policy = CompanionRecovery()
var now = 100.0
for delay in [1.0, 3.0, 10.0] {
    policy.helperEnded(at: now, unexpected: true, ownerRunning: true)
    let due = policy.nextLaunchAt
    policy.helperEnded(at: now + 0.01, unexpected: true, ownerRunning: true)
    assert(policy.nextLaunchAt == due, "duplicate exit must not create another retry")
    assert(!policy.shouldLaunch(at: now + delay - 0.01, ownerRunning: true))
    assert(policy.shouldLaunch(at: now + delay, ownerRunning: true))
    assert(!policy.shouldLaunch(at: now + delay, ownerRunning: true), "same retry runs once")
    now += delay + 100_000 // Survival alone must never replenish the budget.
}
policy.helperEnded(at: now, unexpected: true, ownerRunning: true)
assert(policy.retries == 3 && policy.stopped && policy.nextLaunchAt == nil)
assert(!policy.shouldLaunch(at: now + 100, ownerRunning: true))

var cleanExit = CompanionRecovery()
cleanExit.helperEnded(at: 0, unexpected: false, ownerRunning: true)
assert(cleanExit.stopped && !cleanExit.shouldLaunch(at: 100, ownerRunning: true))

var ownerExit = CompanionRecovery()
ownerExit.helperEnded(at: 0, unexpected: true, ownerRunning: true)
assert(!ownerExit.shouldLaunch(at: 10, ownerRunning: false))
assert(ownerExit.stopped && !ownerExit.shouldLaunch(at: 20, ownerRunning: true))

var cancelled = CompanionRecovery()
cancelled.helperEnded(at: 0, unexpected: true, ownerRunning: true)
cancelled.cancel()
assert(!cancelled.shouldLaunch(at: 100, ownerRunning: true))
print("macos_companion_recovery_ok")
