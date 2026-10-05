import MonoDesign
import SwiftUI

/// A project mascot (11 §11.7): an 8 × 8 sprite in the project colour,
/// crisp. While busy it swaps to its talk frame with a 1 pt lift every
/// 460 ms; under Reduce Motion it rests (M9).
struct MascotView: View {
  var projectId: String
  var busy: Bool
  var size: CGFloat = 16
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let sprite = Mascots.forProject(projectId)
    let color = Tokens.projectColor(projectId).color
    if busy && !reduceMotion {
      TimelineView(.periodic(from: .distantPast, by: 0.46)) { context in
        let talk = Int(context.date.timeIntervalSinceReferenceDate / 0.46) % 2 == 1
        Sprite(rows: talk ? sprite.talk : sprite.rest, color: color)
          .frame(width: size, height: size)
          .offset(y: talk ? -1 : 0)
      }
    } else {
      Sprite(rows: sprite.rest, color: color).frame(width: size, height: size)
    }
  }

  private struct Sprite: View {
    var rows: [String]
    var color: Color

    var body: some View {
      Canvas { context, size in
        let cell = size.width / 8
        var path = Path()
        for (y, row) in rows.enumerated() {
          for (x, char) in row.enumerated() where char == "#" {
            path.addRect(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell))
          }
        }
        context.fill(path, with: .color(color))
      }
      .accessibilityHidden(true)
    }
  }
}
