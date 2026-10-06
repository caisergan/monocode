import MonoDesign
import MonoSync
import SwiftUI

/// Welcome (11 §11.11): the desktop's empty-session composition, a centred
/// heading over the dot grid with one primary action.
struct WelcomeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.palette) private var palette

  var body: some View {
    VStack(spacing: 0) {
      Spacer()
      Image("AppMark")
        .resizable()
        .interpolation(.high)
        .frame(width: 72, height: 72)
        .clipShape(.rect(cornerRadius: 16))
        .accessibilityHidden(true)
      Text("Your agents, wherever you are.")
        .font(.mono(Tokens.TypeScale.emptyHeading, .medium))
        .foregroundStyle(palette.content.color)
        .multilineTextAlignment(.center)
        .padding(.top, 20)
      Text("Approve, answer and start coding agents on your computers.")
        .font(.mono(Tokens.TypeScale.secondary))
        .foregroundStyle(palette.text.tertiary.color)
        .multilineTextAlignment(.center)
        .padding(.top, 8)
      if let notice = model.engine.pairingNotice {
        Text(notice)
          .font(.mono(Tokens.TypeScale.secondary))
          .foregroundStyle(palette.text.secondary.color)
          .multilineTextAlignment(.center)
          .padding(.top, 16)
      }
      Spacer()
      VStack(spacing: 8) {
        Button("Pair with a computer") { model.presentPairing() }
          .buttonStyle(MonoButtonStyle(variant: .primary))
        Button("Try the demo") { model.tryDemo() }
          .buttonStyle(MonoButtonStyle(variant: .ghost))
      }
      .padding(.bottom, 24)
    }
    .padding(.horizontal, 28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { DotGrid().ignoresSafeArea() }
  }
}
