// zcode-metrics · 置顶速度徽章（macOS, AppKit, 零第三方依赖）
// 用法: tsd-badge <port> [x y] [dataDir]
// 行为: 无边框浮动面板（不抢焦点、置顶、跨 Space），每秒 GET /api/state，
//       跟随当前会话（最近一次提交消息/打开的会话，后台其他会话生成不抢占）；
//       生成中显示本轮平均速度，空闲显示上一回合/最近响应。
//       0.5s 轮询 CGWindowList 跟随 ZCode 窗口移动/缩放（按右下角增量平移，无需辅助功能权限）。
//       可拖动（位置持久化到 <dataDir>/badge-pos.json，优先于窗口右下角默认位），双击退出；收集器失联 15s 自动退出。
import AppKit

// MARK: - 六档配色（与 dashboard/uicard.mjs TIERS 单源对齐，改动须两边同步）
// 档色为亮度阶梯：越慢越深、越快越亮（慢深快浅，2026-10-13 用户需求，替换旧红绿灯语义色）
let tiers: [(min: Double, color: NSColor)] = [
  (0,   NSColor(hex: 0x4A7A9A)), (40,  NSColor(hex: 0x6FA3C6)), (80,  NSColor(hex: 0x96C4E0)),
  (160, NSColor(hex: 0xB8DBEE)), (240, NSColor(hex: 0xDCEEF8)), (320, NSColor(hex: 0xFFFFFF)),
]
func tierColor(_ v: Double) -> NSColor {
  var c = tiers[0].color
  for t in tiers where v >= t.min { c = t.color }
  return c
}

extension NSColor {
  convenience init(hex: UInt32) {
    self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
              blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}

// MARK: - /api/state 最小解析（sessions 已按 lastUserMs 降序，取首个 = 当前会话）
struct SessionView {
  let generating: Bool
  let turnAvg: Double?; let turnElapsedMs: Double
  let closedAvg: Double?; let lastTokPerSec: Double?
  static func parse(_ s: [String: Any]) -> SessionView {
    let turn = s["turn"] as? [String: Any] ?? [:]
    let closed = s["closed"] as? [String: Any] ?? [:]
    let last = s["last"] as? [String: Any] ?? [:]
    func num(_ o: Any?) -> Double? { if let n = o as? Double, n.isFinite, n > 0 { return n }; return nil }
    return SessionView(generating: (s["generating"] as? Bool) ?? false,
                       turnAvg: num(turn["avgTokPerSec"]),
                       turnElapsedMs: num(turn["elapsedMs"]) ?? 0,
                       closedAvg: num(closed["avgTokPerSec"]),
                       lastTokPerSec: num(last["tokPerSec"]))
  }
}

// MARK: - UI
final class BadgePanel: NSPanel {
  override var canBecomeKey: Bool { false } // 永不抢焦点
}

final class Badge: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let panel: BadgePanel
  let label = NSTextField(labelWithString: "… tok/s")
  let port: Int
  let posFile: String?
  let spawnRect: CGRect? // 收集器传来的 ZCode 窗口矩形（AppleScript 左上原点），用于免权限识别窗口
  var healthFails = 0
  var timer: Timer?
  var trackTimer: Timer?
  var zcodeWindowID: Int?
  var lastZcodeBR: CGPoint?

  init(port: Int, at point: NSPoint?, posFile: String?, spawnRect: CGRect? = nil) {
    self.port = port
    self.posFile = posFile
    self.spawnRect = spawnRect
    let frame = NSRect(x: 0, y: 0, width: 138, height: 28)
    panel = BadgePanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                       backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true

    let chip = NSView(frame: NSRect(origin: .zero, size: frame.size))
    chip.wantsLayer = true
    chip.layer?.backgroundColor = NSColor(white: 0.10, alpha: 0.92).cgColor
    chip.layer?.cornerRadius = 9
    chip.layer?.borderWidth = 1
    chip.layer?.borderColor = NSColor(white: 1, alpha: 0.10).cgColor
    label.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
    label.textColor = NSColor(hex: 0x9A9AA2)
    label.alignment = .center
    label.cell?.wraps = false
    label.lineBreakMode = .byTruncatingTail
    chip.addSubview(label)
    // 垂直居中用约束钉死（frame 布局下 label 单行文本可能贴顶，不同 macOS 版本行为不一致）
    label.translatesAutoresizingMaskIntoConstraints = false
    label.centerXAnchor.constraint(equalTo: chip.centerXAnchor).isActive = true
    label.centerYAnchor.constraint(equalTo: chip.centerYAnchor).isActive = true
    panel.contentView = chip

    super.init()
    panel.delegate = self
    // 位置优先级：用户拖过并持久化的位置 > 收集器传来的窗口右下角 > 主屏右下角兜底
    let pt = restoredPos() ?? point ?? defaultPos()
    panel.setFrameOrigin(pt)
    // 双击退出（拖动由 isMovableByWindowBackground 处理，不冲突）
    let dbl = NSClickGestureRecognizer(target: self, action: #selector(quit))
    dbl.numberOfClicksRequired = 2
    chip.addGestureRecognizer(dbl)
  }

  func defaultPos() -> NSPoint {
    let sv = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    return NSPoint(x: sv.maxX - 160, y: sv.minY + 14) // 兜底：主屏右下角
  }

  func restoredPos() -> NSPoint? {
    guard let posFile, let data = FileManager.default.contents(atPath: posFile),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
          let x = obj["x"], let y = obj["y"] else { return nil }
    let p = NSPoint(x: x, y: y)
    return NSScreen.screens.contains { $0.visibleFrame.contains(p) } ? p : nil // 换屏幕/改分辨率后防丢
  }

  func windowDidMove(_ n: Notification) {
    guard let posFile else { return }
    let f = panel.frame
    if let d = try? JSONSerialization.data(withJSONObject: ["x": f.minX, "y": f.minY]) {
      try? d.write(to: URL(fileURLWithPath: posFile))
    }
  }

  // MARK: 生命周期
  func applicationDidFinishLaunching(_ n: Notification) {
    writePidFile() // 徽章自管 badge.pid：无论谁拉起（收集器/手动），收集器都能凭它判断存活、避免重复弹
    start()
  }

  var pidFile: String? {
    posFile.map { ($0 as NSString).deletingLastPathComponent + "/badge.pid" }
  }
  func writePidFile() {
    guard let pidFile else { return }
    try? "{\"pid\":\(ProcessInfo.processInfo.processIdentifier)}".data(using: .utf8)?.write(to: URL(fileURLWithPath: pidFile))
  }
  func removePidFile() {
    guard let pidFile else { return }
    try? FileManager.default.removeItem(atPath: pidFile)
  }

  // MARK: 轮询
  func start() {
    panel.orderFrontRegardless()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.poll() }
    trackTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.trackZcodeWindow() }
  }

  // MARK: 跟随 ZCode 窗口（CGWindowList 轮询：bounds/owner 公开信息，无需辅助功能/屏幕录制权限）
  // 识别优先级：记住的 windowID > 与 spawnRect 吻合的窗口（免 ownerName，防权限差异）> ownerName=="ZCode" 的 0 层窗口。
  // 跟随方式：按窗口右下角增量平移徽章（坐标系差异只影响 y 方向符号），用户拖动后的相对位置保持不变。
  func trackZcodeWindow() {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return }
    var win: [String: Any]?
    if let id = zcodeWindowID {
      win = list.first { ($0[kCGWindowNumber as String] as? Int) == id }
    }
    if win == nil, let r = spawnRect {
      win = list.first { w in
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let x = (b["X"] as? NSNumber)?.doubleValue, let y = (b["Y"] as? NSNumber)?.doubleValue,
              let w = (b["Width"] as? NSNumber)?.doubleValue, let h = (b["Height"] as? NSNumber)?.doubleValue else { return false }
        return abs(x - r.minX) < 2 && abs(y - r.minY) < 2 && abs(w - r.width) < 2 && abs(h - r.height) < 2
      }
    }
    if win == nil {
      win = list.first {
        ($0[kCGWindowOwnerName as String] as? String) == "ZCode" && ($0[kCGWindowLayer as String] as? Int) == 0
      }
    }
    zcodeWindowID = win?[kCGWindowNumber as String] as? Int
    guard let b = win?[kCGWindowBounds as String] as? [String: Any],
          let x = (b["X"] as? NSNumber)?.doubleValue, let y = (b["Y"] as? NSNumber)?.doubleValue,
          let w = (b["Width"] as? NSNumber)?.doubleValue, let h = (b["Height"] as? NSNumber)?.doubleValue,
          w > 200, h > 200 else {
      zcodeWindowID = nil
      lastZcodeBR = nil // ZCode 窗口不在（最小化/全屏隐藏）：停在原地等它回来
      return
    }
    let br = CGPoint(x: x + w, y: y + h) // CG 全局坐标（左上原点）；只用增量，坐标系自洽
    defer { lastZcodeBR = br }
    guard let last = lastZcodeBR, last != br else { return }
    var nf = panel.frame
    nf.origin.x += br.x - last.x
    nf.origin.y -= br.y - last.y // CG 的 y 向下增长、Cocoa 向上：方向取反
    panel.setFrameOrigin(nf.origin)
  }

  func poll() {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!)
    req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { self?.render(data: data, status: (resp as? HTTPURLResponse)?.statusCode) }
    }.resume()
  }

  func render(data: Data?, status: Int?) {
    guard status == 200, let data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sessions = obj["sessions"] as? [[String: Any]] else {
      healthFails += 1
      if healthFails >= 15 { quit() } // 收集器没了：自动退（hook 会随下次事件复活整套）
      label.stringValue = "… tok/s"
      label.textColor = NSColor(hex: 0x9A9AA2)
      return
    }
    healthFails = 0
    // 当前会话（sessions[0] = 最近用户交互的会话）；大数字口径与 UI 卡 hero 一致：生成中本轮 → 上一回合 → 最近响应
    let v: Double?
    let generating: Bool
    if let s = sessions.first {
      let sv = SessionView.parse(s)
      generating = sv.generating
      v = (sv.generating ? sv.turnAvg : nil) ?? sv.closedAvg ?? sv.lastTokPerSec
    } else {
      generating = false
      v = nil // 无会话桶：等 hook 事件建桶
    }
    let dot = generating ? "● " : "○ "
    if let v {
      label.stringValue = String(format: "%@%@ tok/s", dot, v >= 100 ? String(format: "%.0f", v) : String(format: "%.1f", v))
      label.textColor = tierColor(v)
    } else {
      label.stringValue = generating ? "● … tok/s" : "○ — tok/s"
      label.textColor = NSColor(hex: 0x9A9AA2)
    }
  }

  @objc func quit() {
    timer?.invalidate()
    trackTimer?.invalidate()
    removePidFile() // 徽章不在了：收集器下一条消息（speedBadge 开）会自动补拉；彻底关闭请关 speedBadge 开关
    panel.orderOut(nil)
    NSApp.terminate(nil)
  }
}

// MARK: - 入口
// 用法: tsd-badge <port> <dataDir> [wx wy ww wh]（窗口矩形为 AppleScript 左上原点坐标，内部转 Cocoa）
let args = CommandLine.arguments
guard args.count >= 3, let port = Int(args[1]) else {
  FileHandle.standardError.write("usage: tsd-badge <port> <dataDir> [wx wy ww wh]\n".data(using: .utf8)!)
  exit(64)
}
var point: NSPoint?
var spawnRect: CGRect?
if args.count >= 7, let wx = Double(args[3]), let wy = Double(args[4]), let ww = Double(args[5]), let wh = Double(args[6]) {
  // 目标：ZCode 窗口右下角内侧（输入框区域右侧）；换算到 Cocoa 左下原点
  let screen = NSScreen.screens.first { abs($0.frame.width - CGFloat(ww)) < 2 } ?? NSScreen.main
  let sf = screen?.frame ?? NSRect(x: 0, y: 0, width: ww, height: wh + 200)
  let y = sf.maxY - CGFloat(wy + wh) + 18
  let x = CGFloat(wx) + CGFloat(ww) - 138 - 22
  point = NSPoint(x: x, y: min(max(y, (screen?.visibleFrame.minY ?? 0) + 8), sf.maxY))
  spawnRect = CGRect(x: wx, y: wy, width: ww, height: wh) // CG 坐标（左上原点），供窗口跟随识别
}
let posFile = args[2] + "/badge-pos.json"

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 无 Dock 图标、不抢焦点
let badge = Badge(port: port, at: point, posFile: posFile, spawnRect: spawnRect)
app.delegate = badge
app.run()
