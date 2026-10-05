#if DEBUG
import SwiftUI

/// S19: 500 session cards in a List, flung for 10 s (16 §16.8). Filled in
/// with the session cards.
struct CardFlingView: View {
  var body: some View {
    Text("Card fling")
      .navigationTitle("Card fling (S19)")
      .toolbarTitleDisplayMode(.inline)
  }
}
#endif
