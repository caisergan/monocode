#if DEBUG
import MonoTranscript
import SwiftUI

/// Debug → Transcript Lab. Nothing sits between the navigation bar and the
/// transcript, so it shows whether the hosted view scrolls under the glass
/// bar with the scroll-edge effect (16 §16.7, R0).
struct TranscriptLabView: View {
  var run: LabRun?
  @State private var lab = TranscriptLab()
  @State private var statusHeight: CGFloat = 0

  var body: some View {
    TranscriptHost(transcript: lab.transcript, bottomBars: statusHeight)
      .ignoresSafeArea()
      .navigationTitle("Transcript Lab")
      .toolbarTitleDisplayMode(.inline)
      .toolbarVisibility(.hidden, for: .tabBar)
      .safeAreaBar(edge: .bottom) {
        Text(lab.summary)
          .font(.caption2.monospaced())
          .foregroundStyle(lab.result.map { $0.hitches == 0 } == false ? .orange : .secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .glassEffect(.regular, in: .rect(cornerRadius: 12))
          .padding(.horizontal, 12)
          .padding(.bottom, 4)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { statusHeight = $0 }
      }
      .toolbar {
        ToolbarItemGroup(placement: .bottomBar) {
          Button("120") { Task { await lab.load(.rows120) } }
          Button("1,000") { Task { await lab.load(.rows1000) } }
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItemGroup(placement: .bottomBar) {
          Button(lab.streaming ? "Stop" : "Stream") {
            if lab.streaming { lab.stopStream() } else { Task { await lab.startStream() } }
          }
          Button("Fling 10 s") { lab.fling() }
            .disabled(lab.benchmarking)
        }
      }
      .task(id: run) {
        if let run { await lab.run(run) }
      }
      .onDisappear { lab.stopStream() }
  }
}

/// The control for the scroll-edge check: a plain SwiftUI List in the same
/// stack, under the same bars. The transcript should look like this.
struct ScrollEdgeControlView: View {
  var body: some View {
    ScrollViewReader { proxy in
      List(0..<200, id: \.self) { i in
        Text("Row \(i). The session host keeps the channel open while the phone measures each row.")
          .font(.body)
      }
      .listStyle(.plain)
      .onAppear { proxy.scrollTo(100, anchor: .center) }
    }
    .navigationTitle("Scroll edge control")
    .toolbarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .bottomBar) {
        Button("120") {}
        Button("1,000") {}
      }
    }
  }
}
#endif
