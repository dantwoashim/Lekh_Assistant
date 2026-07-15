import Foundation

@main
private struct LekhCompanionStateTests {
  private struct ExpectedState {
    let installed: Bool
    let registered: Bool
    let enabled: Bool
    let selected: Bool
    let running: Bool
    let build: KeyboardBuildVerification
    let action: KeyboardPrimaryAction
    let recovery: KeyboardRecoveryPlan
  }

  static func main() {
    let healthy = KeyboardReadiness.healthy(
      processIdentifier: 4242,
      controllerInitializedAt: Date(timeIntervalSince1970: 1)
    )
    let truthTable: [(String, KeyboardReadiness, ExpectedState)] = [
      (
        "missing bundle",
        .missing,
        ExpectedState(
          installed: false, registered: false, enabled: false, selected: false, running: false,
          build: .notChecked, action: .showInstallLocation, recovery: .install
        )
      ),
      (
        "bundle only",
        .installedUnregistered,
        ExpectedState(
          installed: true, registered: false, enabled: false, selected: false, running: false,
          build: .notChecked, action: .register, recovery: .register
        )
      ),
      (
        "registered but disabled",
        .approvalRequired,
        ExpectedState(
          installed: true, registered: true, enabled: false, selected: false, running: false,
          build: .notChecked, action: .enable, recovery: .enable
        )
      ),
      (
        "enabled but not selected",
        .enabledNotSelected,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: false, running: false,
          build: .notChecked, action: .select, recovery: .select
        )
      ),
      (
        "selected without live evidence",
        .selectedUntested,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: false,
          build: .notChecked, action: .verify, recovery: .verify
        )
      ),
      (
        "healthy matching runtime",
        healthy,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: true,
          build: .matched, action: .write, recovery: .ready
        )
      ),
      (
        "stale runtime build",
        .degraded(.wrongBuild),
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: false,
          build: .mismatched, action: .replaceBuild, recovery: .replaceBuild
        )
      )
    ]

    for (name, readiness, expected) in truthTable {
      check(readiness.installed == expected.installed, "\(name): installed")
      check(readiness.registered == expected.registered, "\(name): registered")
      check(readiness.enabled == expected.enabled, "\(name): enabled")
      check(readiness.selected == expected.selected, "\(name): selected")
      check(readiness.running == expected.running, "\(name): running")
      check(readiness.buildVerification == expected.build, "\(name): build")
      check(readiness.primaryAction == expected.action, "\(name): primary action")
      check(readiness.recoveryPlan == expected.recovery, "\(name): recovery")
    }

    let reconnectFailures: [KeyboardFailure] = [
      .unreadableHealth, .wrongConnection, .processExited, .controllerMissing
    ]
    for failure in reconnectFailures {
      let readiness = KeyboardReadiness.degraded(failure)
      check(readiness.primaryAction == .reconnect, "\(failure.rawValue): reconnect action")
      check(readiness.recoveryPlan == .reconnect, "\(failure.rawValue): reconnect recovery")
      check(!readiness.running, "\(failure.rawValue): must not claim running")
      check(readiness.buildVerification == .notChecked, "\(failure.rawValue): build must be unverified")
    }

    for failure in [KeyboardFailure.wrongSchema, .wrongBundle, .wrongBuild] {
      let readiness = KeyboardReadiness.degraded(failure)
      check(readiness.primaryAction == .replaceBuild, "\(failure.rawValue): replace action")
      check(readiness.recoveryPlan == .replaceBuild, "\(failure.rawValue): replace recovery")
    }

    let bundleOnly = NativeKeyboardStatus(readiness: .installedUnregistered)
    check(bundleOnly.installed, "bundle-only snapshot must report installed")
    check(!bundleOnly.registered, "bundle-only snapshot must not report registered")
    check(!bundleOnly.enabled, "bundle-only snapshot must never report enabled")
    check(!bundleOnly.selected, "bundle-only snapshot must never report selected")
    check(!bundleOnly.running, "bundle-only snapshot must never report running")

    print("LekhCompanionStateTests passed: authoritative lifecycle truth table")
  }

  private static func check(
    _ condition: @autoclosure () -> Bool,
    _ message: @autoclosure () -> String
  ) {
    guard condition() else { fatalError(message()) }
  }
}
