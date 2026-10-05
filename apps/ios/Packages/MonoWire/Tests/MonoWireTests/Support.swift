import Foundation
import MonoWire
import Testing

/// A golden fixture from `scripts/gen-fixtures.mjs`, as raw JSON.
func fixture(_ name: String) throws -> Any {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONSerialization.jsonObject(with: Data(contentsOf: url), options: [.fragmentsAllowed])
}

/// Re-serialises a parsed JSON value so a Codable type can decode it.
func decode<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
  return try JSONDecoder().decode(type, from: data)
}

/// Encodes with JSONEncoder and parses back, for comparing with a fixture.
func json(_ value: some Encodable) throws -> Any {
  try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
}

/// The first place two JSON trees differ, or nil when they are equal.
func jsonDifference(_ a: Any, _ b: Any, path: String = "$") -> String? {
  switch (a, b) {
  case let (x as [String: Any], y as [String: Any]):
    for key in Set(x.keys).union(y.keys).sorted() {
      guard let left = x[key] else { return "\(path).\(key): missing in the first" }
      guard let right = y[key] else { return "\(path).\(key): missing in the second" }
      if let difference = jsonDifference(left, right, path: "\(path).\(key)") { return difference }
    }
    return nil
  case let (x as [Any], y as [Any]):
    if x.count != y.count { return "\(path): \(x.count) items against \(y.count)" }
    for (i, (left, right)) in zip(x, y).enumerated() {
      if let difference = jsonDifference(left, right, path: "\(path)[\(i)]") { return difference }
    }
    return nil
  case (is NSNull, is NSNull):
    return nil
  case let (x as NSNumber, y as NSNumber):
    return x == y ? nil : "\(path): \(x) against \(y)"
  case let (x as String, y as String):
    return x == y ? nil : "\(path): \(x.debugDescription) against \(y.debugDescription)"
  default:
    return "\(path): \(a) against \(b)"
  }
}

/// Decodes `value` as `T`, re-encodes it and expects the same JSON back.
@discardableResult
func expectRoundTrip<T: Codable>(_ type: T.Type, _ value: Any, sourceLocation: SourceLocation = #_sourceLocation) throws -> T {
  let decoded = try decode(type, from: value)
  let difference = jsonDifference(value, try json(decoded))
  #expect(difference == nil, "\(T.self): \(difference ?? "")", sourceLocation: sourceLocation)
  return decoded
}
