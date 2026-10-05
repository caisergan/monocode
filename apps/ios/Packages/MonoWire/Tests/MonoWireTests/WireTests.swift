import Foundation
import MonoWire
import Testing

/// The read path's wire objects decode from the TypeScript demo's answers and
/// re-encode to the same JSON (16 §16.5).
@Suite struct WireTests {
  let samples: [String: Any]

  init() throws {
    samples = try #require(try fixture("wire-samples") as? [String: Any])
  }

  @Test func inboxList() throws {
    let inbox = try expectRoundTrip(InboxList.self, samples["inbox"]!)
    #expect(inbox.items.count == 3)
    #expect(inbox.items.allSatisfy { $0.attention.kind == .finished })
  }

  @Test func projectsModelsAndPages() throws {
    try expectRoundTrip([HostProject].self, samples["projects"]!)
    let models = try expectRoundTrip(ModelCatalog.self, samples["models"]!)
    #expect(models.name(of: "claude:opus-4-6") == "Claude Opus 4.6")
    let page = try expectRoundTrip(SessionPage.self, samples["page"]!)
    #expect(page.items.count == 50)
    #expect(page.cursor != nil)
    #expect(page.items.first?.pinned == true)
  }

  @Test func olderPagesAndUnchanged() throws {
    try expectRoundTrip(OlderBlocks.self, samples["older"]!)
    let unchanged = try expectRoundTrip(SessionSync.self, samples["unchanged"]!)
    guard case let .unchanged(revision, window) = unchanged else {
      Issue.record("expected unchanged")
      return
    }
    #expect(revision == 1)
    #expect(window != nil)
  }

  @Test func unknownValuesStayOpen() throws {
    let json = #"""
      {"id":"b","role":"hologram","text":"hi","future":{"x":1},"tool":{"kind":"teleport","preview":{"kind":"video"}}}
      """#
    let block = try JSONDecoder().decode(Block.self, from: Data(json.utf8))
    #expect(block.role.rawValue == "hologram")
    #expect(!block.role.isKnown)
    #expect(block.role != .assistant)
    #expect(block.tool?.preview?.kind.isKnown == false)
    let item = #"{"sessionId":"s","projectId":"p","projectName":"p","title":"t","harness":"zed","status":"paused","attention":"snoozed","needsInput":false,"updatedAt":1,"revision":1}"#
    let decoded = try JSONDecoder().decode(InboxItem.self, from: Data(item.utf8))
    #expect(decoded.attention.kind?.isKnown == false)
    #expect(!decoded.status.isKnown)
  }

  @Test func nullAttentionAndAnchorReencodeAsNull() throws {
    let item = try JSONDecoder().decode(
      InboxItem.self,
      from: Data(#"{"sessionId":"s","projectId":"p","projectName":"p","title":"t","harness":"claude","status":"running","attention":null,"needsInput":false,"updatedAt":1,"revision":1}"#.utf8))
    let object = try #require(try json(item) as? [String: Any])
    #expect(object["attention"] is NSNull)
    let meta = try #require(try json(WindowMeta(anchor: nil, olderTurns: 0, olderBlocks: 0)) as? [String: Any])
    #expect(meta["anchor"] is NSNull)
  }
}

/// `applySessionSync` against the TypeScript's before / sync / after cases.
@Suite struct SyncTests {
  @Test func casesMatchTypeScript() throws {
    let root = try #require(try fixture("sync-cases") as? [String: Any])
    let cases = try #require(root["cases"] as? [[String: Any]])
    #expect(cases.count == 14)
    for item in cases {
      let name = item["name"] as? String ?? "?"
      let before = try item["before"].map { try decode(HostSession.self, from: $0) }
      let sync = try expectRoundTrip(SessionSync.self, item["sync"]!)
      if let message = item["error"] as? String {
        #expect(throws: (any Error).self, "\(name)") { try applySessionSync(before, sync) }
        do {
          _ = try applySessionSync(before, sync)
        } catch let error as SessionSyncError {
          #expect(error.message == message, "\(name)")
        }
        continue
      }
      let after = try applySessionSync(before, sync)
      let difference = jsonDifference(try #require(item["after"]), try json(after))
      #expect(difference == nil, "\(name): \(difference ?? "")")
    }
  }

  @Test func windowHelpersMatchTheHostRules() throws {
    func user(_ id: String, draft: Bool = false) -> Block {
      var block = Block(id: id, role: .user, text: id)
      if draft { block.draft = true }
      return block
    }
    let blocks = [user("u0"), Block(id: "a0", role: .assistant, text: "a"), user("u1"), Block(id: "a1", role: .assistant, text: "b"), user("u2"), user("d", draft: true)]
    #expect(SessionWindow.turnStarts(blocks) == [0, 2, 4])
    #expect(SessionWindow.start(blocks, SyncWindow(tailTurns: 2)) == (2, false))
    #expect(SessionWindow.start(blocks, SyncWindow(anchor: "a1")) == (3, false))
    #expect(SessionWindow.start(blocks, SyncWindow(anchor: "gone", tailTurns: 1)) == (4, true))
    #expect(SessionWindow.meta(blocks, start: 2) == WindowMeta(anchor: "u1", olderTurns: 1, olderBlocks: 2))
    let older = SessionWindow.older(blocks, before: "u2", turns: 1)
    #expect(older.blocks.map(\.id) == ["u1", "a1"])
    #expect(older.olderTurns == 1)
  }
}
