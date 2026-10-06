import Foundation
import MonoChannel
import Testing

/// A fixture from `scripts/gen-channel-fixtures.mjs` (or a copied vector
/// file), decoded as `T`.
func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}

func hex(_ text: String) throws -> Data { try Data(hex: text) }
func b64(_ text: String) throws -> Data { try Data(base64URL: text) }

/// Encodes with JSONEncoder and parses back, for comparing with a fixture.
func json(_ value: some Encodable) throws -> JSONValue {
  try JSONValue(value)
}

/// The first place two JSON trees differ, or nil when they are equal.
func jsonDifference(_ a: JSONValue, _ b: JSONValue, path: String = "$") -> String? {
  switch (a, b) {
  case let (.object(x), .object(y)):
    for key in Set(x.keys).union(y.keys).sorted() {
      guard let left = x[key] else { return "\(path).\(key): missing in the first" }
      guard let right = y[key] else { return "\(path).\(key): missing in the second" }
      if let difference = jsonDifference(left, right, path: "\(path).\(key)") { return difference }
    }
    return nil
  case let (.array(x), .array(y)):
    if x.count != y.count { return "\(path): \(x.count) items against \(y.count)" }
    for (i, (left, right)) in zip(x, y).enumerated() {
      if let difference = jsonDifference(left, right, path: "\(path)[\(i)]") { return difference }
    }
    return nil
  default:
    return a == b ? nil : "\(path): \(a) against \(b)"
  }
}

/// Decodes `value` as `T`, re-encodes it and expects the same JSON back.
@discardableResult
func expectRoundTrip<T: Codable>(
  _ type: T.Type, _ value: JSONValue, sourceLocation: SourceLocation = #_sourceLocation
) throws -> T {
  let decoded = try value.decode(T.self)
  let difference = jsonDifference(value, try json(decoded))
  #expect(difference == nil, "\(T.self): \(difference ?? "")", sourceLocation: sourceLocation)
  return decoded
}
