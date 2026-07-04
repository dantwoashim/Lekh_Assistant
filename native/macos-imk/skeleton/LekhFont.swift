import AppKit

enum LekhFont {
  static func devanagari(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    let prefersSemibold = weight.rawValue >= NSFont.Weight.semibold.rawValue
    let candidates = prefersSemibold
      ? [
        "Kohinoor Devanagari-Semibold",
        "Noto Sans Devanagari SemiBold",
        "Devanagari Sangam MN Bold",
        "Kohinoor Devanagari",
        "Noto Sans Devanagari",
        "Devanagari Sangam MN"
      ]
      : [
        "Kohinoor Devanagari",
        "Noto Sans Devanagari",
        "Devanagari Sangam MN"
      ]

    for name in candidates {
      if let font = NSFont(name: name, size: size) {
        return font
      }
    }
    return .systemFont(ofSize: size, weight: weight)
  }
}
