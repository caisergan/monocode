/// The desktop's project mascots (11 §11.7): ten 8 × 8 pixel sprites drawn
/// in the project colour. The sprites are generated; the picks are here.
public enum Mascots {
  public struct Sprite: Sendable, Hashable {
    public let name: String
    public let rest: [String]
    public let talk: [String]
  }

  /// `projectMascot`: a stable pick per project, hashed differently from
  /// the colour so the two vary independently.
  public static func forProject(_ id: String) -> Sprite {
    var hash: UInt32 = 0
    for unit in id.utf16 { hash = hash &* 131 &+ UInt32(unit) }
    return all[Int(hash % UInt32(all.count))]
  }
}

extension Tokens {
  /// `projectColor`: the project colour index, hashed from its id (1 to 8;
  /// 0 is the neutral colour).
  public static func projectColorIndex(_ id: String) -> Int {
    var hash: UInt32 = 0
    for unit in id.utf16 { hash = hash &* 31 &+ UInt32(unit) }
    return Int(hash % UInt32(projectColors.count - 1)) + 1
  }

  public static func projectColor(_ id: String) -> MonoColor {
    projectColors[projectColorIndex(id)]
  }
}
