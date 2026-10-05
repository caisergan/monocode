import MonoDesign
import SwiftUI

/// MonoCode's segmented control (the desktop sidebar's tabs, 11 §11.14):
/// options on `fill.code`, the selected one on `sel.strong`. Content, not
/// chrome, so it is drawn here rather than by the system.
struct Segmented<Value: Hashable>: View {
  var options: [(value: Value, label: String)]
  @Binding var selection: Value
  @Environment(\.palette) private var palette
  @Namespace private var namespace

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.value) { option in
        let selected = option.value == selection
        Button {
          withAnimation(Tokens.Motion.easeOut.animation(milliseconds: Tokens.Motion.feedbackMs)) { selection = option.value }
        } label: {
          Text(option.label)
            .font(.mono(Tokens.TypeScale.secondary, .medium))
            .foregroundStyle(selected ? palette.content.color : palette.text.secondary.color)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background {
              if selected {
                RoundedRectangle(cornerRadius: Tokens.Radius.sm)
                  .fill(palette.selection.strong.color)
                  .matchedGeometryEffect(id: "selected", in: namespace)
              }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .padding(2)
    .background(palette.fill.code.color, in: .rect(cornerRadius: Tokens.Radius.md))
    .sensoryFeedback(.selection, trigger: selection)
  }
}
