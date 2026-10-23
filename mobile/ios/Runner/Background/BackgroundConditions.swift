import Foundation
import UIKit

/// Why an automatic backup in the background waits
enum BackgroundPauseReason: String {
  case notCharging
  case lowPowerMode
  case hot
}

/// The conditions an automatic backup in the background runs under, besides those iOS holds for the processing task
/// itself ("processing tasks run only when the device is idle", and with `requiresExternalPower` only on power):
/// the backup stops when the phone is unplugged, in Low Power Mode ("disable syncs and backups", Apple's Energy
/// Efficiency Guide) and when it gets warm (from `.fair`: "defer background work").
enum BackgroundConditions {
  /// Why the backup waits now, or nil. Call on the main thread.
  static func pauseReason() -> BackgroundPauseReason? {
    let processInfo = ProcessInfo.processInfo
    if processInfo.isLowPowerModeEnabled {
      return .lowPowerMode
    }
    if processInfo.thermalState != .nominal {
      return .hot
    }
    let device = UIDevice.current
    device.isBatteryMonitoringEnabled = true
    // .unknown: the state cannot be read; iOS started the task on power
    return device.batteryState == .unplugged ? .notCharging : nil
  }

  /// Calls `onPause` (on the main thread) when one of the conditions stops holding, until the returned observers are
  /// removed with `stopObserving`. Call on the main thread.
  static func observe(onPause: @escaping (BackgroundPauseReason) -> Void) -> [NSObjectProtocol] {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let check: (Notification) -> Void = { _ in
      if let reason = pauseReason() {
        onPause(reason)
      }
    }
    let center = NotificationCenter.default
    return [
      center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main, using: check),
      center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main, using: check),
      center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main, using: check),
    ]
  }

  static func stopObserving(_ observers: [NSObjectProtocol]) {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }
}
