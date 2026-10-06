// Notify for Claude Code — the macOS half that shows a notification.
//
// A notification belongs to an app: macOS files it under the sender's bundle identifier,
// asks the user once whether that app may notify, and shows that app's name and icon.
// Plain Node has no bundle, and borrowing VS Code's would mean borrowing its permission,
// so this is a small app of our own. It does three things and exits:
//
//   post     -message M [-title T] [-subtitle S] [-sound NAME] [-group G] [-execute CMD | -open URL]
//   -remove G      withdraw a delivered notification
//   -list G|ALL    print delivered notifications, a header row then tab-separated rows
//   -status        print the permission and the alert style, exit 0 only when allowed
//   -authorize     ask macOS for permission, the same question a first notification asks
//
// A click needs no process left waiting: the command rides in the notification, and macOS
// relaunches this app to deliver the click. Modelled on terminal-notifier 3.x (MIT).

import Cocoa
import UserNotifications

enum Exit: Int32 {
  case ok = 0, usage = 1, badArgument = 2, notAuthorized = 3, timeout = 4, failed = 5
}

func fail(_ message: String, _ code: Exit) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code.rawValue)
}

/// `-name value` pairs and bare `-flags`, as terminal-notifier takes them.
struct Arguments {
  private var values: [String: String] = [:]
  private var flags: Set<String> = []
  static let withValue: Set<String> = ["-title", "-subtitle", "-message", "-sound", "-group", "-execute", "-open", "-remove", "-list"]
  static let bare: Set<String> = ["-status", "-authorize", "-version", "-help"]

  init(_ argv: [String]) {
    var i = 1
    while i < argv.count {
      let arg = argv[i]
      if Arguments.withValue.contains(arg), i + 1 < argv.count {
        values[arg] = argv[i + 1]
        i += 2
      } else {
        if Arguments.bare.contains(arg) { flags.insert(arg) }
        i += 1
      }
    }
  }

  subscript(name: String) -> String? { values[name] }
  func has(_ flag: String) -> Bool { flags.contains(flag) }
  /// Launched by macOS to hand over a click: none of our arguments.
  var isEmpty: Bool { values.isEmpty && flags.isEmpty }
}

func statusName(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .notDetermined: return "notDetermined"
  case .provisional: return "provisional"
  @unknown default: return "unknown"
  }
}

final class Helper: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let center = UNUserNotificationCenter.current()
  let args = Arguments(CommandLine.arguments)
  /// The permission dialog waits on a person; the watchdog must not cut it short.
  var awaitingPerson = false
  var handlingClick = false

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Before launching finishes, or a click that relaunched us arrives unhandled.
    center.delegate = self
    armWatchdog()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if args.has("-version") {
      print(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
      exit(Exit.ok.rawValue)
    }
    if args.has("-help") {
      print("usage: notify -message M [-title T] [-subtitle S] [-sound NAME] [-group G] [-execute CMD | -open URL]")
      print("       notify -remove G | -list G|ALL | -status | -authorize")
      exit(Exit.ok.rawValue)
    }
    if args.isEmpty {
      // macOS relaunched us for a click; the response follows shortly after launch.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if !self.handlingClick { exit(Exit.ok.rawValue) }
      }
      return
    }
    if args.has("-status") { return status() }
    if args.has("-authorize") { return authorize() }
    if let group = args["-remove"] { return remove(group) }
    if let group = args["-list"] { return list(group) }
    guard let message = args["-message"] else { fail("nothing to show: -message is required", .usage) }
    post(message)
  }

  /// Ten seconds is plenty to reach the notification service. Not reaching it means no
  /// GUI session — over SSH, or from launchd as root.
  func armWatchdog() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
      if self.awaitingPerson || self.handlingClick { return self.armWatchdog() }
      fail("timed out waiting for the notification service — is there a logged-in GUI session?", .timeout)
    }
  }

  func status() {
    center.getNotificationSettings { settings in
      print(statusName(settings.authorizationStatus))
      // Persistent ("alert") stays until dealt with; a banner slides away.
      switch settings.alertStyle {
      case .alert: print("style: alert")
      case .banner: print("style: banner")
      default: print("style: none")
      }
      let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
      exit(allowed ? Exit.ok.rawValue : Exit.notAuthorized.rawValue)
    }
  }

  func authorize() {
    awaitingPerson = true
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      self.awaitingPerson = false
      if let error = error { fail("could not ask for permission: \(error.localizedDescription)", .notAuthorized) }
      print(granted ? "authorized" : "denied")
      exit(granted ? Exit.ok.rawValue : Exit.notAuthorized.rawValue)
    }
  }

  /// Runs `block` once allowed, asking first if nobody has been asked yet.
  func whenAllowed(_ block: @escaping () -> Void) {
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional:
        DispatchQueue.main.async(execute: block)
      case .denied:
        fail("notifications are turned off for Notify for Claude Code — System Settings → Notifications", .notAuthorized)
      default:
        self.awaitingPerson = true
        self.center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
          self.awaitingPerson = false
          if !granted { fail("permission to notify was declined", .notAuthorized) }
          DispatchQueue.main.async(execute: block)
        }
      }
    }
  }

  func post(_ message: String) {
    whenAllowed {
      let content = UNMutableNotificationContent()
      content.title = self.args["-title"] ?? "Claude"
      if let subtitle = self.args["-subtitle"] { content.subtitle = subtitle }
      content.body = message
      if let sound = self.args["-sound"] {
        content.sound = sound == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(sound))
      }
      var info: [String: String] = [:]
      if let command = self.args["-execute"] { info["execute"] = command }
      if let url = self.args["-open"] { info["open"] = url }
      content.userInfo = info

      // The same identifier replaces the earlier notification: one per session.
      let group = self.args["-group"]
      if let group = group {
        content.threadIdentifier = group
        self.center.removeDeliveredNotifications(withIdentifiers: [group])
      }
      let request = UNNotificationRequest(identifier: group ?? UUID().uuidString, content: content, trigger: nil)
      self.center.add(request) { error in
        if let error = error { fail("could not deliver: \(error.localizedDescription)", .failed) }
        exit(Exit.ok.rawValue)
      }
    }
  }

  func remove(_ group: String) {
    center.removeDeliveredNotifications(withIdentifiers: [group])
    // The removal has no completion handler; give it a moment to land.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(Exit.ok.rawValue) }
  }

  func list(_ group: String) {
    center.getDeliveredNotifications { delivered in
      let rows = delivered
        .filter { group == "ALL" || $0.request.identifier == group }
        .map { n in
          [n.request.identifier, n.request.content.title, n.request.content.subtitle, n.request.content.body,
           ISO8601DateFormatter().string(from: n.date)]
            .map { $0.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ") }
            .joined(separator: "\t")
        }
      print((["GroupID\tTitle\tSubtitle\tMessage\tDelivered At"] + rows).joined(separator: "\n"))
      exit(Exit.ok.rawValue)
    }
  }

  // MARK: UNUserNotificationCenterDelegate

  /// Shown even when this app is in front — it never is, but macOS asks.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    handlingClick = true
    completionHandler()
    let request = response.notification.request
    center.removeDeliveredNotifications(withIdentifiers: [request.identifier])
    // Dismissing it is a response too; only a click acts.
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { exit(Exit.ok.rawValue) }

    var ok = true
    if let command = request.content.userInfo["execute"] as? String {
      let task = Process()
      task.executableURL = URL(fileURLWithPath: "/bin/sh")
      task.arguments = ["-c", command]
      task.standardOutput = FileHandle.nullDevice
      task.standardError = FileHandle.nullDevice
      do {
        try task.run()
        task.waitUntilExit()
        ok = task.terminationStatus == 0
      } catch {
        ok = false
      }
    }
    if let url = (request.content.userInfo["open"] as? String).flatMap(URL.init(string:)) {
      ok = NSWorkspace.shared.open(url) && ok
    }
    exit(ok ? Exit.ok.rawValue : Exit.failed.rawValue)
  }
}

let app = NSApplication.shared
let helper = Helper()
app.delegate = helper
app.run()
