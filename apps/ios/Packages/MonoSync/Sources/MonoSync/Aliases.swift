// The app reads `HostRecord`s from the stores, so MonoStore's types come
// with MonoSync: the app needs no project reference of its own to them.
@_exported import MonoStore
import MonoWire

// MonoChannel, MonoWire and MonoStore each name some of the same things. A
// file that imports MonoChannel uses these names for MonoWire's types, so no
// name is ambiguous there.

/// The host's error as the screens read it (06 §6.11).
public typealias WireError = MonoWire.ChannelError
/// The welcome as the stores keep it: what the screens need of it.
public typealias WireWelcome = MonoWire.Welcome
