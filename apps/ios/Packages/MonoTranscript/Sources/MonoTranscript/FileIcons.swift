import CoreGraphics
import Foundation
import UIKit

/// The desktop's file-type icons (11 §11.7): the Material Icon Theme glyphs
/// `build-native-assets.mjs` exports into this package's asset catalog, and
/// the desktop's `resolveFileIcon` rules for picking one.
public enum FileIcons {
  /// The bundle holding `FileIcons.xcassets`, for `Image(_:bundle:)`.
  public static let bundle = Bundle.module

  private struct Tables: Decodable {
    var fileNames: [String: String]
    var fileExtensions: [String: String]
  }

  private static let tables: Tables = {
    guard let url = Bundle.module.url(forResource: "file-icons", withExtension: "json"),
      let data = try? Data(contentsOf: url), let tables = try? JSONDecoder().decode(Tables.self, from: data)
    else { return Tables(fileNames: [:], fileExtensions: [:]) }
    return tables
  }()

  /// The icon for a file name: the whole name, then each compound suffix
  /// (`d.ts`, then `ts`), else the generic file.
  public static func name(for fileName: String) -> String {
    let key = fileName.lowercased()
    if let icon = tables.fileNames[key] { return icon }
    let parts = key.components(separatedBy: ".")
    let start = parts.first == "" ? 1 : 0
    if parts.count > start + 1 {
      for i in (start + 1)..<parts.count {
        if let icon = tables.fileExtensions[parts[i...].joined(separator: ".")] { return icon }
      }
    }
    return "file"
  }

  private static let location = try! NSRegularExpression(pattern: "(:\\d+(:\\d+)?|#L\\d+(-L?\\d+)?)$")

  /// The icon for a file reference as a chip shows it: a path, possibly with
  /// `:line[:col]` or `#Lstart-Lend`.
  public static func name(forReference reference: String) -> String {
    let range = NSRange(location: 0, length: reference.utf16.count)
    let path = location.stringByReplacingMatches(in: reference, range: range, withTemplate: "")
    let leaf = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    return name(for: leaf)
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var images: [String: CGImage] = [:]

  /// The icon as a bitmap for painting, cached. Nil for an icon the package
  /// ships no glyph for (the desktop draws an empty slot then).
  static func image(_ name: String, size: CGFloat, scale: CGFloat) -> CGImage? {
    let key = "\(name)@\(size)x\(scale)"
    lock.lock()
    if let image = images[key] {
      lock.unlock()
      return image
    }
    lock.unlock()
    guard let vector = UIImage(named: name, in: .module, compatibleWith: nil) else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format).image { _ in
      vector.draw(in: CGRect(x: 0, y: 0, width: size, height: size))
    }.cgImage
    if let image {
      lock.lock()
      images[key] = image
      lock.unlock()
    }
    return image
  }
}
