import BackgroundTasks
import Flutter

/// Keeps a backup that the user started while the app is open going when they leave the app (iOS 26+): a continued
/// processing task, whose progress the system shows, and where the user can stop it. The upload itself goes on in the
/// app's engine; the task only keeps the app running, and ends when the backup does. Apple: "your app needs to run the
/// task only in response to someone's action, such as tapping a button", so the app starts it only then.
///
/// Called on the main thread, as the launch handler of the task runs.
class UserUploadApiImpl: UserUploadApi {
  private let flutterApi: UserUploadFlutterApi
  /// The identifier of the task asked for, until the backup finishes
  private var identifier: String?
  /// The task, once it runs (a BGContinuedProcessingTask)
  private var task: AnyObject?
  private var completed: Int64 = 0
  private var total: Int64 = 0

  init(messenger: FlutterBinaryMessenger) {
    flutterApi = UserUploadFlutterApi(binaryMessenger: messenger)
  }

  func start(title: String, subtitle: String) throws -> Bool {
    guard #available(iOS 26.0, *) else {
      return false
    }
    if identifier != nil {
      return true
    }
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      return false
    }
    // permitted by "<bundle id>.backup.*" in Info.plist; a new one every time, since registering an identifier twice
    // stops the app
    let identifier = "\(bundleIdentifier).backup.\(UUID().uuidString)"
    let isRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
      guard let self, let task = task as? BGContinuedProcessingTask, self.identifier == identifier else {
        // the backup finished before the task started
        task.setTaskCompleted(success: true)
        return
      }
      self.run(task)
    }
    guard isRegistered else {
      return false
    }

    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
    // the backup runs now: a task that starts later would be of no use
    request.strategy = .fail
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      print("UserUploadApiImpl: could not keep the backup going in the background: \(error)")
      return false
    }
    self.identifier = identifier
    completed = 0
    total = 0
    return true
  }

  func progress(completed: Int64, total: Int64) throws {
    self.completed = completed
    self.total = total
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      report(task)
    }
  }

  func finish() throws {
    identifier = nil
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      self.task = nil
      task.setTaskCompleted(success: true)
    }
  }

  @available(iOS 26.0, *)
  private func run(_ task: BGContinuedProcessingTask) {
    self.task = task
    // the user stopped the backup where the system shows it, or the system stopped it
    task.expirationHandler = { [weak self, weak task] in
      DispatchQueue.main.async {
        guard let self, let task, self.task === task else {
          return
        }
        self.identifier = nil
        self.task = nil
        task.setTaskCompleted(success: false)
        self.flutterApi.onStopped { _ in }
      }
    }
    report(task)
  }

  /// The system stops a task that shows no progress
  @available(iOS 26.0, *)
  private func report(_ task: BGContinuedProcessingTask) {
    guard total > 0 else {
      return
    }
    task.progress.totalUnitCount = total
    task.progress.completedUnitCount = min(completed, total)
  }
}
