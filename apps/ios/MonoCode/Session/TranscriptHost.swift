import MonoTranscript
import SwiftUI
import UIKit

/// Hosts the UIKit transcript in SwiftUI (16 §16.6.4). The controller
/// registers the transcript's scroll view as its content scroll view, so the
/// navigation bar and toolbar can see its edges.
struct TranscriptHost: UIViewControllerRepresentable {
  let transcript: MonoTranscriptView
  /// Height of SwiftUI bars over the bottom edge (`safeAreaBar`), which the
  /// hosted controller's UIKit safe area does not include.
  var bottomBars: CGFloat = 0

  func makeUIViewController(context: Context) -> TranscriptHostController {
    TranscriptHostController(transcript: transcript)
  }

  func updateUIViewController(_ controller: TranscriptHostController, context: Context) {
    controller.bottomBars = bottomBars
  }
}

final class TranscriptHostController: UIViewController {
  let transcript: MonoTranscriptView
  var bottomBars: CGFloat = 0 {
    didSet {
      guard bottomBars != oldValue else { return }
      // The composer folding or opening: the rows pinned to the end move
      // with it on the same spring, not in one jump.
      guard oldValue > 0, !UIAccessibility.isReduceMotionEnabled else { return updateInsets() }
      UIView.animate(springDuration: ComposerMotion.duration, bounce: ComposerMotion.bounce) { self.updateInsets() }
    }
  }

  init(transcript: MonoTranscriptView) {
    self.transcript = transcript
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    transcript.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(transcript)
    NSLayoutConstraint.activate([
      transcript.topAnchor.constraint(equalTo: view.topAnchor),
      transcript.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      transcript.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      transcript.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    // `-MCNoContentScrollView YES` skips the registration, to see what it adds.
    if !UserDefaults.standard.bool(forKey: "MCNoContentScrollView") {
      setContentScrollView(transcript.contentScrollView, for: .top)
      setContentScrollView(transcript.contentScrollView, for: .bottom)
    }
  }

  /// The view runs edge to edge; the bars' heights become the transcript's
  /// own insets, so rows scroll under the bars.
  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    updateInsets()
  }

  private func updateInsets() {
    transcript.topInset = view.safeAreaInsets.top
    transcript.bottomInset = view.safeAreaInsets.bottom + bottomBars + 12
  }
}
