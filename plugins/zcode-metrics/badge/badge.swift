// zcode-metrics · 置顶速度徽章（macOS, AppKit, 零第三方依赖）
// 用法: tsd-badge <port> [x y] [dataDir]
// 行为: 无边框浮动面板（不抢焦点、置顶、跨 Space），每秒 GET /api/state，
//       自动跟随最近活跃会话；生成中显示本轮平均速度，空闲显示上一回合/最近响应。
//       可拖动（位置持久化到 <dataDir>/badge-pos.json），双击退出；收集器失联 15s 自动退出。
import AppKit

// MARK: - 六档配色（与 dashboard/uicard.mjs TIERS 单源对齐，改动须两边同步）
let tiers: [(min: Double, color: NSColor)] = [
  (0,   NSColor(hex: 0x4E9C78)), (40,  NSColor(hex: 0xA9C548)), (80,  NSColor(hex: 0xE5C558)),
  (160, NSColor(hex: 0xF2A64B)), (240, NSColor(hex: 0xE06C5F)), (320, NSColor(hex: 0xE05FB0)),
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

// MARK: - /api/state 最小解析（sessions 已按 lastEventMs 降序，取首个 = 最近活跃会话）
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
  var healthFails = 0
  var timer: Timer?

  init(port: Int, at point: NSPoint?, posFile: String?) {
    self.port = port
    self.posFile = posFile
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
    label.frame = chip.bounds.insetBy(dx: 4, dy: 0)
    chip.addSubview(label)
    panel.contentView = chip

    super.init()
    panel.delegate = self
    let pt = point ?? restoredPos() ?? defaultPos()
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
    start()
  }

  // MARK: 轮询
  func start() {
    panel.orderFrontRegardless()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.poll() }
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
    // 最近活跃会话（sessions[0]）；大数字口径与 UI 卡 hero 一致：生成中本轮 → 上一回合 → 最近响应
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
if args.count >= 7, let wx = Double(args[3]), let wy = Double(args[4]), let ww = Double(args[5]), let wh = Double(args[6]) {
  // 目标：ZCode 窗口右下角内侧（输入框区域右侧）；换算到 Cocoa 左下原点
  let screen = NSScreen.screens.first { abs($0.frame.width - CGFloat(ww)) < 2 } ?? NSScreen.main
  let sf = screen?.frame ?? NSRect(x: 0, y: 0, width: ww, height: wh + 200)
  let y = sf.maxY - CGFloat(wy + wh) + 18
  let x = CGFloat(wx) + CGFloat(ww) - 138 - 22
  point = NSPoint(x: x, y: min(max(y, (screen?.visibleFrame.minY ?? 0) + 8), sf.maxY))
}
let posFile = args[2] + "/badge-pos.json"

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 无 Dock 图标、不抢焦点
let badge = Badge(port: port, at: point, posFile: posFile)
app.delegate = badge
app.run()
