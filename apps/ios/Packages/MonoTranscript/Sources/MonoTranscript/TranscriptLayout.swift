import CoreGraphics
import CoreText
import QuartzCore
import UIKit

// Measures one row with CoreText at the viewport width and keeps the objects
// it measured with, so painting can never disagree with the measured height.
// Runs on the layout queue; RowLayout is immutable once built.

private let gutter: CGFloat = 16
private let chipKey = NSAttributedString.Key("MonoChip")
private let linkKey = NSAttributedString.Key("MonoLink")
/// A file chip's reference (its text) and its icon placeholder's icon name.
private let fileKey = NSAttributedString.Key("MonoFile")
private let iconKey = NSAttributedString.Key("MonoIcon")
/// File-type icons in chips (11 §11.16): 16 pt, then a 3 pt gap.
private let iconSize: CGFloat = 16

struct Hit: Sendable {
  let rect: CGRect
  let action: String?
  let link: String?
  /// A file chip's reference, as its text reads.
  var file: String? = nil
}

/// A wrapped block of text: the frame CoreText laid out, its size, and the
/// chip and link rectangles found in it (top-left coordinates). Immutable
/// after init; the CoreText objects are only read once built.
final class TextBlock: @unchecked Sendable {
  let frame: CTFrame
  let size: CGSize
  let pathHeight: CGFloat
  let chips: [(CGRect, Int)]
  let links: [(CGRect, String)]
  /// File chips and the reference each one opens.
  let files: [(CGRect, String)]
  /// File-type icons to draw over the chips' placeholders.
  let icons: [(CGRect, String)]
  let usedWidth: CGFloat
  let lineCount: Int

  init(frame: CTFrame, size: CGSize, pathHeight: CGFloat, chips: [(CGRect, Int)], links: [(CGRect, String)],
       files: [(CGRect, String)], icons: [(CGRect, String)], usedWidth: CGFloat, lineCount: Int) {
    self.frame = frame
    self.size = size
    self.pathHeight = pathHeight
    self.chips = chips
    self.links = links
    self.files = files
    self.icons = icons
    self.usedWidth = usedWidth
    self.lineCount = lineCount
  }
}

enum Element {
  case fill(CGPath, CGColor)
  case stroke(CGPath, CGColor, CGFloat, [CGFloat]?)
  case text(TextBlock, CGPoint)
  /// A single CTLine; the point is its baseline origin in top-left coordinates.
  case line(CTLine, CGPoint)
  /// A file-type icon by name, in top-left coordinates.
  case icon(String, CGRect)
}

/// Immutable once built on the layout queue; painted on the raster queue
/// and the main thread.
final class RowLayout: @unchecked Sendable {
  let id: String
  let version: Int
  let kind: String
  let width: CGFloat
  let height: CGFloat
  let themeRevision: Int
  let elements: [Element]
  let hits: [Hit]
  let pulse: Bool
  let a11y: String
  let measureMs: Double

  init(spec: RowSpec, width: CGFloat, height: CGFloat, theme: TranscriptTheme, elements: [Element], hits: [Hit], measureMs: Double) {
    id = spec.id
    version = spec.version
    kind = spec.kind
    self.width = width
    self.height = max(0, ceil(height))
    themeRevision = theme.revision
    self.elements = elements
    self.hits = hits
    pulse = spec.pulse
    a11y = spec.a11y ?? spec.runs.map(\.text).joined()
    self.measureMs = measureMs
  }

  /// Paints into a top-left (UIKit) context of size width × height.
  func draw(in ctx: CGContext, chipColor: CGColor, fileChipColor: CGColor) {
    for element in elements {
      switch element {
      case let .fill(path, color):
        ctx.addPath(path)
        ctx.setFillColor(color)
        ctx.fillPath()
      case let .stroke(path, color, width, dash):
        ctx.addPath(path)
        ctx.setStrokeColor(color)
        ctx.setLineWidth(width)
        if let dash { ctx.setLineDash(phase: 0, lengths: dash) } else { ctx.setLineDash(phase: 0, lengths: []) }
        ctx.strokePath()
      case let .text(block, origin):
        for (rect, kind) in block.chips {
          let chip = rect.offsetBy(dx: origin.x, dy: origin.y)
          ctx.addPath(CGPath(roundedRect: chip, cornerWidth: kind == 2 ? 4 : 6, cornerHeight: kind == 2 ? 4 : 6, transform: nil))
          ctx.setFillColor(kind == 2 ? fileChipColor : chipColor)
          ctx.fillPath()
        }
        ctx.saveGState()
        ctx.translateBy(x: origin.x, y: origin.y + block.pathHeight)
        ctx.scaleBy(x: 1, y: -1)
        ctx.textMatrix = .identity
        CTFrameDraw(block.frame, ctx)
        ctx.restoreGState()
        for (rect, name) in block.icons { Self.drawIcon(name, in: rect.offsetBy(dx: origin.x, dy: origin.y), ctx: ctx) }
      case let .line(line, baseline):
        ctx.saveGState()
        ctx.translateBy(x: baseline.x, y: baseline.y)
        ctx.scaleBy(x: 1, y: -1)
        ctx.textMatrix = .identity
        ctx.textPosition = .zero
        CTLineDraw(line, ctx)
        ctx.restoreGState()
      case let .icon(name, rect):
        Self.drawIcon(name, in: rect, ctx: ctx)
      }
    }
  }

  /// Draws an icon upright in the top-left (flipped) context.
  private static func drawIcon(_ name: String, in rect: CGRect, ctx: CGContext) {
    let scale = max(1, abs(ctx.userSpaceToDeviceSpaceTransform.a))
    guard let image = FileIcons.image(name, size: rect.width, scale: scale) else { return }
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.maxY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(image, in: CGRect(origin: .zero, size: rect.size))
    ctx.restoreGState()
  }
}

enum RowLayouter {
  // MARK: Attributed strings

  static func attributed(_ runs: [TextRun], theme: TranscriptTheme, lineHeight: CGFloat? = nil) -> NSAttributedString {
    let out = NSMutableAttributedString()
    let first = theme.style(runs.first?.style ?? "prose")
    var height = lineHeight ?? first.lineHeight
    // The settings point at `height`, so they must be used inside its scope.
    let paragraph = withUnsafePointer(to: &height) { pointer in
      let settings = [
        CTParagraphStyleSetting(spec: .minimumLineHeight, valueSize: MemoryLayout<CGFloat>.size, value: pointer),
        CTParagraphStyleSetting(spec: .maximumLineHeight, valueSize: MemoryLayout<CGFloat>.size, value: pointer),
      ]
      return CTParagraphStyleCreate(settings, settings.count)
    }
    for run in runs {
      let style = theme.style(run.style)
      var attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): style.font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): style.color,
        NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
      ]
      if let link = run.link { attributes[linkKey] = link }
      if run.chip == 2 {
        // A file chip: the icon's placeholder, then the name, all one chip
        // that opens the file.
        attributes[chipKey] = 2
        attributes[fileKey] = run.text
        var icon = attributes
        icon[iconKey] = FileIcons.name(forReference: run.text)
        icon[NSAttributedString.Key(kCTRunDelegateAttributeName as String)] = iconPlaceholder(font: style.font)
        out.append(NSAttributedString(string: "\u{202F}", attributes: attributes))
        out.append(NSAttributedString(string: "\u{FFFC}", attributes: icon))
        out.append(NSAttributedString(string: "\u{2060}" + String(unbreakable(run.text).dropFirst()), attributes: attributes))
        continue
      }
      var text = run.text
      if run.chip > 0 {
        attributes[chipKey] = run.chip
        text = unbreakable(text)
      }
      out.append(NSAttributedString(string: text, attributes: attributes))
    }
    return out
  }

  /// The width an icon takes in the line, with the font's own ascent and
  /// descent so the line keeps its height.
  private final class IconMetrics {
    let ascent: CGFloat
    let descent: CGFloat
    init(ascent: CGFloat, descent: CGFloat) {
      self.ascent = ascent
      self.descent = descent
    }
  }

  static func iconPlaceholder(font: CTFont) -> CTRunDelegate {
    var callbacks = CTRunDelegateCallbacks(
      version: kCTRunDelegateVersion1,
      dealloc: { Unmanaged<IconMetrics>.fromOpaque($0).release() },
      getAscent: { Unmanaged<IconMetrics>.fromOpaque($0).takeUnretainedValue().ascent },
      getDescent: { Unmanaged<IconMetrics>.fromOpaque($0).takeUnretainedValue().descent },
      getWidth: { _ in iconSize + 3 })
    let metrics = IconMetrics(ascent: CTFontGetAscent(font), descent: CTFontGetDescent(font))
    return CTRunDelegateCreate(&callbacks, Unmanaged.passRetained(metrics).toOpaque())!
  }

  /// A chip never splits across lines (15 §15.4): narrow no-break spaces pad
  /// it, its spaces become no-break spaces, and word joiners sit between its
  /// characters, so CoreText moves it to the next line whole. A chip wider
  /// than the line still breaks; truncating it in the middle is not built.
  static func unbreakable(_ text: String) -> String {
    let glued = text.map { $0 == " " ? "\u{00A0}" : String($0) }.joined(separator: "\u{2060}")
    return "\u{202F}\(glued)\u{202F}"
  }

  static func textBlock(_ string: NSAttributedString, width: CGFloat) -> TextBlock {
    let framesetter = CTFramesetterCreateWithAttributedString(string as CFAttributedString)
    let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
      framesetter, CFRange(location: 0, length: 0), nil,
      CGSize(width: max(1, width), height: .greatestFiniteMagnitude), nil)
    let height = ceil(suggested.height)
    let pathHeight = height + 1
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: max(1, width), height: pathHeight), transform: nil)
    let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil)
    let lines = CTFrameGetLines(frame) as! [CTLine]
    var origins = [CGPoint](repeating: .zero, count: lines.count)
    CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
    var chips: [(CGRect, Int)] = []
    var links: [(CGRect, String)] = []
    var files: [(CGRect, String)] = []
    var icons: [(CGRect, String)] = []
    var used: CGFloat = 0
    for (index, line) in lines.enumerated() {
      let origin = origins[index]
      let lineWidth = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line))
      used = max(used, lineWidth)
      for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let attributes = CTRunGetAttributes(run) as NSDictionary
        let chip = attributes[chipKey] as? Int
        let link = attributes[linkKey] as? String
        if chip == nil && link == nil { continue }
        let range = CTRunGetStringRange(run)
        let start = CTLineGetOffsetForStringIndex(line, range.location, nil)
        let end = CTLineGetOffsetForStringIndex(line, range.location + range.length, nil)
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
        _ = CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0), &ascent, &descent, nil)
        // Path coordinates are bottom-left; convert to the block's top-left.
        let top = pathHeight - (origin.y + ascent + 3)
        let rect = CGRect(x: origin.x + start, y: top, width: end - start, height: ascent + descent + 6)
        if let chip {
          if let lastIndex = chips.indices.last, chips[lastIndex].1 == chip,
             abs(chips[lastIndex].0.maxX - rect.minX) < 0.5, abs(chips[lastIndex].0.minY - rect.minY) < 2 {
            chips[lastIndex].0 = chips[lastIndex].0.union(rect)
          } else {
            chips.append((rect, chip))
          }
        }
        if let link { links.append((rect, link)) }
        if let file = attributes[fileKey] as? String {
          if let last = files.indices.last, files[last].1 == file, abs(files[last].0.maxX - rect.minX) < 0.5,
            abs(files[last].0.minY - rect.minY) < 2
          {
            files[last].0 = files[last].0.union(rect)
          } else {
            files.append((rect, file))
          }
        }
        if let icon = attributes[iconKey] as? String {
          icons.append((CGRect(x: rect.minX + 1, y: rect.midY - iconSize / 2, width: iconSize, height: iconSize), icon))
        }
      }
    }
    return TextBlock(frame: frame, size: CGSize(width: width, height: height), pathHeight: pathHeight,
                     chips: chips, links: links, files: files, icons: icons, usedWidth: ceil(used), lineCount: lines.count)
  }

  /// One line, truncated with an ellipsis at `width`.
  static func singleLine(_ runs: [TextRun], theme: TranscriptTheme, width: CGFloat) -> (CTLine, CGFloat) {
    let string = attributed(runs, theme: theme)
    let line = CTLineCreateWithAttributedString(string as CFAttributedString)
    let natural = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    if natural <= width { return (line, natural) }
    let style = theme.style(runs.last?.style ?? "prose")
    let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): style.font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): style.color,
    ]) as CFAttributedString)
    let truncated = CTLineCreateTruncatedLine(line, Double(max(1, width)), .end, ellipsis) ?? line
    return (truncated, width)
  }

  static func baseline(for line: CTLine, top: CGFloat, height: CGFloat) -> CGFloat {
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    _ = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
    return top + (height - (ascent + descent)) / 2 + ascent
  }

  // MARK: Rows

  static func make(_ spec: RowSpec, width: CGFloat, theme: TranscriptTheme) -> RowLayout {
    let started = CACurrentMediaTime()
    var elements: [Element] = []
    var hits: [Hit] = []
    var height: CGFloat = spec.gap
    let inner = max(1, width - gutter * 2)

    switch spec.kind {
    case "spacer":
      height = spec.height

    case "userBubble":
      let maxWidth = min(inner - 40, inner * 0.85)
      let block = textBlock(attributed(spec.runs, theme: theme), width: maxWidth - 24)
      let bubbleWidth = min(maxWidth, block.usedWidth + 24)
      let bubbleHeight = block.size.height + 16
      let x = width - gutter - bubbleWidth
      let rect = CGRect(x: x, y: height, width: bubbleWidth, height: bubbleHeight)
      let radius: CGFloat = block.lineCount <= 1 ? bubbleHeight / 2 : 12
      elements.append(.fill(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil), theme.color("bubble")))
      if spec.status == "draft" {
        elements.append(.stroke(CGPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerWidth: radius, cornerHeight: radius, transform: nil),
                                theme.color("borderDashed"), 1, [4, 3]))
      }
      elements.append(.text(block, CGPoint(x: x + 12, y: height + 8)))
      height += bubbleHeight
      if !spec.sub.isEmpty {
        let (line, lineWidth) = singleLine(spec.sub, theme: theme, width: inner)
        elements.append(.line(line, CGPoint(x: width - gutter - lineWidth, y: baseline(for: line, top: height + 4, height: 20))))
        height += 24
      }
      height += 4

    case "codeBlock":
      let box = CGRect(x: gutter, y: height, width: inner, height: 0)
      var y = height
      var codeElements: [Element] = []
      if spec.first {
        let label = [TextRun(text: spec.label ?? "", style: "codeLabel")]
        let (line, _) = singleLine(label, theme: theme, width: inner - 24)
        codeElements.append(.line(line, CGPoint(x: box.minX + 12, y: baseline(for: line, top: y, height: 36))))
        y += 36
      }
      let codeStyle = theme.style("code")
      for lineRuns in spec.lines {
        let runs = lineRuns.isEmpty ? [TextRun(text: " ", style: "code")] : lineRuns
        let (line, _) = singleLine(runs, theme: theme, width: inner - 24)
        codeElements.append(.line(line, CGPoint(x: box.minX + 12, y: baseline(for: line, top: y, height: codeStyle.lineHeight))))
        y += codeStyle.lineHeight
      }
      if spec.last { y += 10 }
      let full = CGRect(x: box.minX, y: height, width: inner, height: y - height)
      let path = chunkPath(full, first: spec.first, last: spec.last, radius: 10)
      elements.append(.fill(path.fill, theme.color("code")))
      elements.append(.stroke(path.stroke, theme.color("border"), 1, nil))
      elements.append(contentsOf: codeElements)
      if spec.first {
        hits.append(Hit(rect: CGRect(x: full.maxX - 56, y: height, width: 56, height: 36), action: "copy", link: nil))
      }
      height = y

    case "trailRow", "thinkingRow", "turnFooter":
      let rowHeight: CGFloat = spec.kind == "turnFooter" ? 30 : 30
      let x = spec.kind == "trailRow" ? gutter + 20 : gutter
      if spec.kind == "trailRow" {
        let spine = CGMutablePath()
        spine.move(to: CGPoint(x: gutter + 6.5, y: height))
        spine.addLine(to: CGPoint(x: gutter + 6.5, y: height + (spec.last ? rowHeight / 2 : rowHeight)))
        spine.move(to: CGPoint(x: gutter + 6.5, y: height + rowHeight / 2 - 6))
        spine.addQuadCurve(to: CGPoint(x: gutter + 14, y: height + rowHeight / 2), control: CGPoint(x: gutter + 6.5, y: height + rowHeight / 2))
        elements.append(.stroke(spine, theme.color("rail"), 1, nil))
      }
      let (line, _) = singleLine(spec.runs + spec.sub, theme: theme, width: width - x - gutter)
      let base = baseline(for: line, top: height, height: rowHeight)
      // Chips in a single line: measure them from the line itself.
      var icons: [Element] = []
      var fileRect: (CGRect, String)?
      for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let attributes = CTRunGetAttributes(run) as NSDictionary
        guard let chip = attributes[chipKey] as? Int else { continue }
        let range = CTRunGetStringRange(run)
        let start = CTLineGetOffsetForStringIndex(line, range.location, nil)
        let end = CTLineGetOffsetForStringIndex(line, range.location + range.length, nil)
        let rect = CGRect(x: x + start, y: height + 4, width: end - start, height: rowHeight - 8)
        elements.append(.fill(CGPath(roundedRect: rect, cornerWidth: 4, cornerHeight: 4, transform: nil),
                              theme.color(chip == 2 ? "fileChip" : "chip")))
        if let icon = attributes[iconKey] as? String {
          icons.append(.icon(icon, CGRect(x: rect.minX + 1, y: rect.midY - iconSize / 2, width: iconSize, height: iconSize)))
        }
        if let file = attributes[fileKey] as? String {
          fileRect = (fileRect.map { $0.0.union(rect) } ?? rect, file)
        }
      }
      elements.append(.line(line, CGPoint(x: x, y: base)))
      elements.append(contentsOf: icons)
      if let (rect, file) = fileRect {
        hits.append(Hit(rect: rect.insetBy(dx: -4, dy: -6), action: nil, link: nil, file: file))
      }
      if spec.actions.first != nil || spec.kind == "trailRow" {
        hits.append(Hit(rect: CGRect(x: 0, y: height, width: width, height: rowHeight), action: spec.actions.first?.id ?? "open", link: nil))
      }
      height += rowHeight

    case "foldLine":
      let rowHeight: CGFloat = 34
      let mid = height + rowHeight / 2
      let chevron = CGMutablePath()
      if spec.open {
        chevron.move(to: CGPoint(x: gutter + 1, y: mid - 2.5))
        chevron.addLine(to: CGPoint(x: gutter + 5, y: mid + 1.5))
        chevron.addLine(to: CGPoint(x: gutter + 9, y: mid - 2.5))
      } else {
        chevron.move(to: CGPoint(x: gutter + 3, y: mid - 4))
        chevron.addLine(to: CGPoint(x: gutter + 7, y: mid))
        chevron.addLine(to: CGPoint(x: gutter + 3, y: mid + 4))
      }
      elements.append(.stroke(chevron, theme.color("chevron"), 1.5, nil))
      let (line, _) = singleLine(spec.runs, theme: theme, width: inner - 18)
      elements.append(.line(line, CGPoint(x: gutter + 18, y: baseline(for: line, top: height, height: rowHeight))))
      hits.append(Hit(rect: CGRect(x: 0, y: height, width: width, height: rowHeight), action: "fold", link: nil))
      height += rowHeight

    case "approvalControls":
      let card = CGRect(x: gutter, y: height, width: inner, height: 0)
      var y = height + 12
      var cardElements: [Element] = []
      let title = textBlock(attributed(spec.runs, theme: theme), width: inner - 24)
      cardElements.append(.text(title, CGPoint(x: card.minX + 12, y: y)))
      y += title.size.height
      if !spec.lines.isEmpty {
        y += 6
        let codeStyle = theme.style("code")
        for lineRuns in spec.lines.prefix(8) {
          let (line, _) = singleLine(lineRuns.isEmpty ? [TextRun(text: " ", style: "code")] : lineRuns, theme: theme, width: inner - 24)
          cardElements.append(.line(line, CGPoint(x: card.minX + 12, y: baseline(for: line, top: y, height: codeStyle.lineHeight))))
          y += codeStyle.lineHeight
        }
      }
      y += 10
      var x = card.maxX - 12
      for action in spec.actions.reversed() {
        let style = action.variant == "primary" ? "primaryLabel" : action.variant == "danger" ? "dangerLabel" : "buttonLabel"
        let (line, lineWidth) = singleLine([TextRun(text: action.label, style: style)], theme: theme, width: 200)
        let buttonWidth = lineWidth + 28
        let rect = CGRect(x: x - buttonWidth, y: y, width: buttonWidth, height: 34)
        let fill = action.variant == "primary" ? theme.color("primary") : theme.color("bubble")
        cardElements.append(.fill(CGPath(roundedRect: rect, cornerWidth: 8, cornerHeight: 8, transform: nil), fill))
        cardElements.append(.line(line, CGPoint(x: rect.minX + 14, y: baseline(for: line, top: rect.minY, height: rect.height))))
        hits.append(Hit(rect: rect.insetBy(dx: -4, dy: -6), action: action.id, link: nil))
        x = rect.minX - 8
      }
      y += 34 + 12
      let full = CGRect(x: card.minX, y: height, width: inner, height: y - height)
      elements.append(.fill(CGPath(roundedRect: full, cornerWidth: 10, cornerHeight: 10, transform: nil), theme.color("code")))
      elements.append(.stroke(CGPath(roundedRect: full.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 10, cornerHeight: 10, transform: nil),
                              theme.color("borderDashed"), 1, [4, 3]))
      elements.append(contentsOf: cardElements)
      height = y

    case "notice":
      let dot = CGRect(x: gutter + 1, y: height + 9, width: 10, height: 10)
      elements.append(.stroke(CGPath(ellipseIn: dot, transform: nil), theme.color(spec.status == "interrupt" ? "attention" : "danger"), 1.5, nil))
      let block = textBlock(attributed(spec.runs, theme: theme), width: inner - 20)
      elements.append(.text(block, CGPoint(x: gutter + 20, y: height + 2)))
      height += block.size.height + 6

    case "loadOlder":
      let (line, lineWidth) = singleLine([TextRun(text: spec.label ?? "Load earlier messages", style: "buttonLabel")], theme: theme, width: inner)
      let rect = CGRect(x: (width - lineWidth - 24) / 2, y: height + 10, width: lineWidth + 24, height: 32)
      elements.append(.fill(CGPath(roundedRect: rect, cornerWidth: 8, cornerHeight: 8, transform: nil), theme.color("chip")))
      elements.append(.line(line, CGPoint(x: rect.minX + 12, y: baseline(for: line, top: rect.minY, height: rect.height))))
      hits.append(Hit(rect: rect.insetBy(dx: -8, dy: -8), action: "older", link: nil))
      height += 52

    default: // markdown, and unknown kinds as plain text
      var x = gutter + CGFloat(spec.depth) * 24
      if spec.quote {
        let bar = CGRect(x: x, y: height, width: 3, height: 0)
        x += 16
        let block = textBlock(attributed(spec.runs, theme: theme), width: width - x - gutter)
        elements.append(.fill(CGPath(roundedRect: CGRect(x: bar.minX, y: height, width: 3, height: block.size.height),
                                     cornerWidth: 1.5, cornerHeight: 1.5, transform: nil), theme.color("quoteBar")))
        elements.append(.text(block, CGPoint(x: x, y: height)))
        appendLinkHits(block, origin: CGPoint(x: x, y: height), into: &hits)
        height += block.size.height
        break
      }
      if let marker = spec.marker {
        let style = theme.style(spec.runs.first?.style ?? "prose")
        let (line, _) = singleLine([TextRun(text: marker, style: "marker")], theme: theme, width: 24)
        elements.append(.line(line, CGPoint(x: x + 4, y: baseline(for: line, top: height, height: style.lineHeight))))
        x += 24
      }
      let block = textBlock(attributed(spec.runs, theme: theme), width: width - x - gutter)
      elements.append(.text(block, CGPoint(x: x, y: height)))
      appendLinkHits(block, origin: CGPoint(x: x, y: height), into: &hits)
      height += block.size.height
    }

    let ms = (CACurrentMediaTime() - started) * 1000
    return RowLayout(spec: spec, width: width, height: height, theme: theme, elements: elements, hits: hits, measureMs: ms)
  }

  private static func appendLinkHits(_ block: TextBlock, origin: CGPoint, into hits: inout [Hit]) {
    for (rect, link) in block.links {
      hits.append(Hit(rect: rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -4, dy: -6), action: nil, link: link))
    }
    for (rect, file) in block.files {
      hits.append(Hit(rect: rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -4, dy: -6), action: nil, link: nil, file: file))
    }
  }

  /// A code card cut into chunks: only the first chunk has the top edge and
  /// corners, only the last the bottom.
  private static func chunkPath(_ rect: CGRect, first: Bool, last: Bool, radius r: CGFloat) -> (fill: CGPath, stroke: CGPath) {
    let fill = CGMutablePath()
    let topRadius = first ? r : 0
    let bottomRadius = last ? r : 0
    fill.move(to: CGPoint(x: rect.minX, y: rect.minY + topRadius))
    if first { fill.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + r, y: rect.minY), radius: r) }
    else { fill.addLine(to: CGPoint(x: rect.minX, y: rect.minY)) }
    fill.addLine(to: CGPoint(x: rect.maxX - topRadius, y: rect.minY))
    if first { fill.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r), radius: r) }
    fill.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRadius))
    if last { fill.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - r, y: rect.maxY), radius: r) }
    else { fill.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY)) }
    fill.addLine(to: CGPoint(x: rect.minX + bottomRadius, y: rect.maxY))
    if last { fill.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - r), radius: r) }
    else { fill.addLine(to: CGPoint(x: rect.minX, y: rect.maxY)) }
    fill.closeSubpath()

    let inset = rect.insetBy(dx: 0.5, dy: 0)
    let stroke = CGMutablePath()
    let top = inset.minY + (first ? 0.5 : 0)
    let bottom = inset.maxY - (last ? 0.5 : 0)
    if first {
      stroke.move(to: CGPoint(x: inset.minX, y: bottom - (last ? r : 0)))
      stroke.addLine(to: CGPoint(x: inset.minX, y: top + r))
      stroke.addArc(tangent1End: CGPoint(x: inset.minX, y: top), tangent2End: CGPoint(x: inset.minX + r, y: top), radius: r)
      stroke.addLine(to: CGPoint(x: inset.maxX - r, y: top))
      stroke.addArc(tangent1End: CGPoint(x: inset.maxX, y: top), tangent2End: CGPoint(x: inset.maxX, y: top + r), radius: r)
      stroke.addLine(to: CGPoint(x: inset.maxX, y: bottom - (last ? r : 0)))
    } else {
      stroke.move(to: CGPoint(x: inset.minX, y: top))
      stroke.addLine(to: CGPoint(x: inset.minX, y: bottom - (last ? r : 0)))
      stroke.move(to: CGPoint(x: inset.maxX, y: top))
      stroke.addLine(to: CGPoint(x: inset.maxX, y: bottom - (last ? r : 0)))
    }
    if last {
      if first {
        stroke.addArc(tangent1End: CGPoint(x: inset.maxX, y: bottom), tangent2End: CGPoint(x: inset.maxX - r, y: bottom), radius: r)
        stroke.addLine(to: CGPoint(x: inset.minX + r, y: bottom))
        stroke.addArc(tangent1End: CGPoint(x: inset.minX, y: bottom), tangent2End: CGPoint(x: inset.minX, y: bottom - r), radius: r)
      } else {
        stroke.addArc(tangent1End: CGPoint(x: inset.maxX, y: bottom), tangent2End: CGPoint(x: inset.maxX - r, y: bottom), radius: r)
        stroke.addLine(to: CGPoint(x: inset.minX + r, y: bottom))
        stroke.addArc(tangent1End: CGPoint(x: inset.minX, y: bottom), tangent2End: CGPoint(x: inset.minX, y: bottom - r), radius: r)
      }
    }
    return (fill, stroke)
  }
}
