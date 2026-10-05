import MonoDesign
import SwiftUI

/// The desktop's braille spinner (`TerminalSpinner.tsx`): ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ at
/// 80 ms a frame. Every spinner derives its frame from the clock, so they
/// all turn together, as from one ticker (11 §11.6). Static under Reduce
/// Motion.
struct BrailleSpinner: View {
  var color: Color
  var size: CGFloat = 12
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let frames = Array("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")

  var body: some View {
    TimelineView(.periodic(from: .distantPast, by: 0.08)) { context in
      let frame = reduceMotion ? 0 : Int(context.date.timeIntervalSinceReferenceDate / 0.08) % Self.frames.count
      Text(String(Self.frames[frame]))
        .font(.system(size: size, design: .monospaced))
        .foregroundStyle(color)
    }
    .accessibilityHidden(true)
  }
}

/// Shimmer text for live titles (`Shimmer.tsx`): the text at α .40 with a
/// full-content band sweeping across it. Under Reduce Motion it is static
/// text at α .70 (M9).
struct ShimmerText: View {
  var text: String
  var font: Font
  var color: Color
  var period: Double = 1.6
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var phase: CGFloat = -1

  var body: some View {
    if reduceMotion {
      Text(text).font(font).foregroundStyle(color.opacity(0.7)).lineLimit(1)
    } else {
      Text(text).font(font).foregroundStyle(color.opacity(0.4)).lineLimit(1)
        .overlay {
          Text(text).font(font).foregroundStyle(color).lineLimit(1)
            .mask {
              GeometryReader { proxy in
                LinearGradient(
                  colors: [.clear, .white, .clear], startPoint: .leading, endPoint: .trailing
                )
                .frame(width: max(40, proxy.size.width * 0.5))
                .offset(x: phase * proxy.size.width)
              }
            }
        }
        .onAppear {
          withAnimation(.linear(duration: period).repeatForever(autoreverses: false)) { phase = 1.2 }
        }
    }
  }
}
