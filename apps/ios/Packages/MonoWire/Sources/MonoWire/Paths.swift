import Foundation

// Path display and resolution (src/shared/lib/paths.ts and
// src/features/files/model/fileName.ts). The phone is never Windows, but a
// host can be, so Windows-shaped paths keep the desktop's rules.

public enum Paths {
  private static let windowsDrive = JSRegex("^[A-Za-z]:[\\\\/]")
  private static let driveRoot = JSRegex("^[A-Za-z]:(?:/|$)")
  private static let bareDrive = JSRegex("^[A-Za-z]:$")
  private static let driveSlash = JSRegex("^[A-Za-z]:/")
  private static let trailingSlashes = JSRegex("/+$")
  private static let backslashes = JSRegex("\\\\", "g")
  private static let remoteRoot = JSRegex("^remote://[^/]+/")
  private static let location = JSRegex("(?::(\\d+)(?::(\\d+))?|#L(\\d+)(?:-L\\d+)?)$")
  private static let scheme = JSRegex("^[a-z][a-z0-9+.-]*:", "i")
  private static let uncStart = JSRegex("^[\\\\/]{2}")
  private static let extensionless = JSRegex("^(dockerfile|makefile|gemfile|license)$", "i")
  private static let fileExtension = JSRegex("\\.[A-Za-z][A-Za-z0-9+]{0,11}$")
  private static let slashDrive = JSRegex("^/[A-Za-z]:/")
  private static let leadingSlashes = JSRegex("^/+")

  static func isWindowsPath(_ path: String) -> Bool {
    windowsDrive.test(path) || path.hasPrefix("\\\\") || path.hasPrefix("//")
  }

  /// `slash`: backslashes to slashes for Windows paths (the phone is not Windows).
  public static func slash(_ path: String) -> String {
    isWindowsPath(path) ? backslashes.replace(path, "/") : path
  }

  static func trimSlash(_ path: String) -> String {
    let trimmed = trailingSlashes.replace(slash(path), "")
    return trimmed.isEmpty ? "/" : trimmed
  }

  /// A stable comparison key: Windows paths compare case-insensitively.
  public static func pathKey(_ path: String) -> String {
    let normalized = trimSlash(path)
    return driveRoot.test(normalized) || normalized.hasPrefix("//") ? normalized.lowercased() : normalized
  }

  public static func parentPath(_ path: String) -> String {
    let trimmed = trimSlash(path)
    if JSRegex("^//[^/]+/[^/]+$").test(trimmed) { return trimmed }
    if bareDrive.test(trimmed) { return "\(trimmed)/" }
    let i = trimmed.jsLastIndexOf("/")
    if i <= 0 { return "/" }
    let parent = trimmed.jsSlice(0, i)
    if bareDrive.test(parent) { return "\(parent)/" }
    return parent
  }

  public static func joinPath(_ parent: String, _ relative: String) -> String {
    let base = trimSlash(parent)
    let parts = (isWindowsPath(parent) ? JSRegex("[/\\\\]").split(relative) : relative.jsSplit("/"))
      .filter { !$0.isEmpty && $0 != "." }
    var out = base
    for part in parts {
      if part == ".." {
        out = parentPath(out)
        continue
      }
      out = out == "/" ? "/\(part)" : "\(out)/\(part)"
    }
    return out
  }

  /// The home directory recognised inside a project path.
  static func homeDir(fromCwd cwd: String) -> String? {
    let root = remoteRoot.match(cwd)?[0] ?? nil
    let trimmed = trimSlash(root.map { "/" + cwd.jsSlice($0.jsLength) } ?? cwd)
    if trimmed == "~" { return nil }
    let parts = trimmed.jsSplit("/").filter { !$0.isEmpty }
    if parts.count >= 2 && (parts[0] == "Users" || parts[0] == "home") {
      let home = "/\(parts[0])/\(parts[1])"
      return root.map { $0 + home.jsSlice(1) } ?? home
    }
    if parts.count >= 3 && bareDrive.test(parts[0]) && parts[1].lowercased() == "users" {
      let home = "\(parts[0])/\(parts[1])/\(parts[2])"
      return root.map { $0 + home } ?? home
    }
    return nil
  }

  /// `resolveWorkspacePath`: the absolute path a workspace file reference names.
  public static func resolveWorkspacePath(_ href: String, cwd: String?) -> String? {
    var value = href.jsTrim
    if value.isEmpty { return nil }
    if let m = location.match(value), let index = location.index(in: value), m[0] != nil {
      value = value.jsSlice(0, index)
    }
    let fileURL = value.hasPrefix("file://")
    if fileURL {
      value = value.jsSlice("file://".jsLength)
      if value.hasPrefix("localhost/") { value = value.jsSlice("localhost".jsLength) }
      value = value.removingPercentEncoding ?? value
    }
    value = slash(value)
    let root = cwd.flatMap { remoteRoot.match($0)?[0] ?? nil }
    if let root, value.hasPrefix(root) { return value }
    if fileURL && uncStart.test(value) { return nil }
    if value == "~" || value.hasPrefix("~/") {
      guard let cwd, let home = homeDir(fromCwd: cwd) else { return nil }
      value = value == "~" ? home : joinPath(home, value.jsSlice(2))
    }
    if let root, value.hasPrefix(root) { return value }
    if scheme.test(value) && !driveSlash.test(value) { return nil }
    if value.isEmpty || value == "." || value.hasPrefix("#") || value.hasPrefix("?") || value.contains("://") {
      return nil
    }
    if !looksLikeFilePath(value) { return nil }
    if driveSlash.test(value) { return root.map { $0 + value } ?? value }
    if let root, value.hasPrefix("//") { return root + value.jsSlice(1) }
    if value.hasPrefix("/") {
      if let root { return root + leadingSlashes.replace(value, "") }
      return slashDrive.test(value) ? value.jsSlice(1) : value
    }
    guard let cwd, cwd != "~" else { return nil }
    return joinPath(cwd, value)
  }

  public static func isExtensionlessFileName(_ value: String) -> Bool {
    extensionless.test(value)
  }

  public static func looksLikeFilePath(_ value: String) -> Bool {
    if value.hasPrefix("/") || driveSlash.test(value) { return true }
    if value.contains("/") { return true }
    return isExtensionlessFileName(value) || fileExtension.test(value)
  }

  /// The path relative to `cwd` when it lives under the project, otherwise unchanged.
  public static func displayPath(_ path: String, cwd: String?) -> String {
    let normalized = trimSlash(path)
    if let cwd {
      let base = trimSlash(cwd)
      if base != "~" {
        let key = pathKey(normalized)
        let baseKey = pathKey(base)
        if key == baseKey { return normalized.jsSplit("/").last { !$0.isEmpty } ?? normalized }
        if key.hasPrefix(baseKey + "/") { return normalized.jsSlice(base.jsLength + 1) }
      }
    }
    return normalized
  }

  /// The last segment of a path (`leafName`).
  public static func leafName(_ raw: String) -> String {
    var name = JSRegex("^\\t+|\\t+$", "g").replace(raw, "")
    name = JSRegex("[/\\\\]+$").replace(name, "")
    return JSRegex("[/\\\\]").split(name).last { !$0.isEmpty } ?? ""
  }
}
