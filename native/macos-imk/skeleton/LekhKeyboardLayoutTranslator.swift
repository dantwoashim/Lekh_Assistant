import AppKit
import Carbon
import Foundation

/// Translates physical macOS key codes through installed system Devanagari
/// layouts. This is deliberately not a hand-written Nepali keymap: production
/// Traditional typing must come from an OS-provided or separately audited layout
/// artifact, and must fail open to host text when that source is unavailable.
final class LekhKeyboardLayoutTranslator {
  static let shared = LekhKeyboardLayoutTranslator()

  private let inputSourceIds = [
    "com.apple.keylayout.Nepali",
    "com.apple.keylayout.Nepali-IS16350",
    "com.apple.keylayout.Devanagari-QWERTY"
  ]

  private var cachedLayoutData: CFData?
  private var cachedSourceId: String?
  private let lock = NSLock()

  private init() {}

  var activeTraditionalSourceId: String? {
    lock.lock()
    defer { lock.unlock() }
    if cachedLayoutData == nil {
      _ = loadTraditionalLayoutDataLocked()
    }
    return cachedSourceId
  }

  func translateTraditionalKey(keyCode: Int, modifiers: NSEvent.ModifierFlags) -> String? {
    guard keyCode >= 0, keyCode <= 127 else { return nil }
    guard !modifiers.contains(.command), !modifiers.contains(.control) else { return nil }

    lock.lock()
    let layoutData = cachedLayoutData ?? loadTraditionalLayoutDataLocked()
    lock.unlock()

    guard let layoutData,
          let layoutBytes = CFDataGetBytePtr(layoutData) else {
      return nil
    }

    var deadKeyState: UInt32 = 0
    var length = 0
    var characters = [UniChar](repeating: 0, count: 16)
    let status = layoutBytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layoutPointer in
      characters.withUnsafeMutableBufferPointer { buffer in
        UCKeyTranslate(
          layoutPointer,
          UInt16(keyCode),
          UInt16(kUCKeyActionDown),
          carbonModifierState(from: modifiers),
          UInt32(LMGetKbdType()),
          OptionBits(kUCKeyTranslateNoDeadKeysBit),
          &deadKeyState,
          buffer.count,
          &length,
          buffer.baseAddress
        )
      }
    }

    guard status == noErr, length > 0 else { return nil }
    let translated = String(utf16CodeUnits: characters, count: length)
    return translated.isEmpty ? nil : translated
  }

  private func loadTraditionalLayoutDataLocked() -> CFData? {
    for inputSourceId in inputSourceIds {
      guard let source = inputSource(id: inputSourceId),
            let rawLayoutData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
        continue
      }
      let layoutData = unsafeBitCast(rawLayoutData, to: CFData.self)
      cachedLayoutData = layoutData
      cachedSourceId = inputSourceId
      return layoutData
    }
    cachedSourceId = nil
    return nil
  }

  private func inputSource(id inputSourceId: String) -> TISInputSource? {
    let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
    guard let unmanagedList = TISCreateInputSourceList(query, false) else {
      return nil
    }
    let list = unmanagedList.takeRetainedValue() as NSArray
    return list.firstObject as! TISInputSource?
  }

  private func carbonModifierState(from modifiers: NSEvent.ModifierFlags) -> UInt32 {
    var state: UInt32 = 0
    if modifiers.contains(.shift) { state |= UInt32(shiftKey >> 8) }
    if modifiers.contains(.option) { state |= UInt32(optionKey >> 8) }
    if modifiers.contains(.capsLock) { state |= UInt32(alphaLock >> 8) }
    return state
  }
}
