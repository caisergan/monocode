import Foundation
import MonoChannel
import Testing

struct OfferFixtures: Decodable {
  let links: [LinkCase]
  let parse: [ParseCase]

  struct LinkCase: Decodable {
    let base: String
    let offer: JSONValue
    let link: String
  }

  struct ParseCase: Decodable {
    let name: String
    let input: String
    let allowInsecureRelay: Bool?
    let offer: JSONValue?
    let error: Failure?
  }

  struct Failure: Decodable {
    let reason: String
    let message: String
  }
}

@Suite struct OfferTests {
  let fixtures: OfferFixtures

  init() throws {
    fixtures = try fixture("offers")
  }

  /// Every rule of 04 §4.2, as parseOfferLink applies it.
  @Test func parsesLikeTheTypeScript() throws {
    #expect(fixtures.parse.count > 60)
    for case_ in fixtures.parse {
      let result = Result { () throws(OfferError) in
        try parseOfferLink(case_.input, allowInsecureRelay: case_.allowInsecureRelay ?? false)
      }
      switch result {
      case let .success(offer):
        let expected = try #require(case_.offer, "\(case_.name): parsed, but TypeScript refused it")
        let difference = jsonDifference(try json(offer), expected)
        #expect(difference == nil, "\(case_.name): \(difference ?? "")")
        try expectRoundTrip(Offer.self, expected)
      case let .failure(error):
        let expected = try #require(case_.error, "\(case_.name): refused, but TypeScript parsed it")
        #expect(error.reason.rawValue == expected.reason, "\(case_.name)")
        #expect(error.message == expected.message, "\(case_.name)")
      }
    }
  }

  @Test func linksRoundTrip() throws {
    #expect(fixtures.links.map(\.base) == ["https://usemono.dev/pair", "monocode://pair", "monocode-dev://pair"])
    for case_ in fixtures.links {
      let offer = try parseOfferLink(case_.link)
      #expect(jsonDifference(try json(offer), case_.offer) == nil)
      let link = try encodeOfferLink(offer, linkBase: case_.base)
      #expect(link.hasPrefix("\(case_.base)#o="))
      #expect(try parseOfferLink(link) == offer)
      #expect(!link.dropFirst(case_.base.count + 3).contains { "+/=".contains($0) })
    }
  }

  @Test func offerAccessors() throws {
    let offer = try parseOfferLink(fixtures.links[0].link)
    #expect(offer.hostKey.count == 32)
    #expect(offer.pairingSecret.count == 32)
    #expect(offer.offerId.count == 16)
    #expect(offer.appearance?.theme == "dark")
    #expect(offer.appearance?.accent == "#4da3f5")
    #expect(offer.isExpired(now: Date(timeIntervalSince1970: 1_760_000_600)))
    #expect(!offer.isExpired(now: Date(timeIntervalSince1970: 1_760_000_000)))
  }
}
