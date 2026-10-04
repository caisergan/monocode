import ExpoModulesCore

public class MonoTranscriptModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MonoTranscript")

    View(MonoTranscriptView.self) {
      Events("onAction", "onLink", "onAtBottomChange", "onNeedOlder", "onBenchmark", "onReady")

      Prop("bottomInset") { (view: MonoTranscriptView, value: Double) in
        view.bottomInset = CGFloat(value)
      }

      Prop("topInset") { (view: MonoTranscriptView, value: Double) in
        view.topInset = CGFloat(value)
      }

      AsyncFunction("apply") { (view: MonoTranscriptView, ops: String) in
        view.apply(ops)
      }

      AsyncFunction("setTheme") { (view: MonoTranscriptView, theme: String) in
        view.setTheme(theme)
      }

      AsyncFunction("scrollToBottom") { (view: MonoTranscriptView, animated: Bool) in
        view.scrollToBottom(animated: animated)
      }

      AsyncFunction("setFollowTail") { (view: MonoTranscriptView, on: Bool) in
        view.setFollowTail(on)
      }

      AsyncFunction("runBenchmark") { (view: MonoTranscriptView, durationMs: Double, speed: Double) in
        view.runBenchmark(durationMs: durationMs, speed: speed)
      }
    }
  }
}
