import Foundation

public enum LekhL10n {
  private static let ne: [String: String] = [
    "app.name": "लेख",
    "menu.preferences": "लेख सेटिङ...",
    "menu.tutorial": "पहिलो प्रयोग ट्युटोरियल...",
    "menu.diagnostics": "डायग्नोस्टिक्स...",
    "menu.dictionaryWarning": "शब्दकोश अपडेट चेतावनी...",
    "menu.forgetCandidate": "हालको सुझाव बिर्सने",
    "mode.romanizedRomanized": "Romanized-Romanized",
    "mode.romanizedTraditional": "Romanized-Traditional",
    "mode.traditionalTraditional": "Traditional-Traditional",
    "mode.traditionalRomanized": "Traditional-Romanized",
    "mode.prompt": "लेख मोड छान्नुहोस्",
    "candidate.badge.unicode": "देवनागरी",
    "candidate.badge.roman": "Roman",
    "candidate.badge.fix": "सुधार",
    "candidate.badge.helper": "सहयोग",
    "candidate.explain.unicode": "Space थिच्दा यो देवनागरी रूप कमिट हुन्छ।",
    "candidate.explain.roman": "Romanized helper रूप।",
    "candidate.explain.fix": "Proofread सुझाव: लेखिएको शब्दलाई यो रूपमा सच्याउन सकिन्छ।",
    "preferences.title": "लेख सेटिङ",
    "preferences.typing": "Typing",
    "preferences.personal": "Personal Dictionary",
    "preferences.diagnostics": "Diagnostics",
    "preferences.tutorial": "Tutorial",
    "preferences.inline": "Inline Devanagari preview",
    "preferences.inlineAlwaysOn": "Inline preview is always on for live typing.",
    "preferences.candidates": "Custom candidate window",
    "preferences.proofread": "Proofread-as-you-type",
    "preferences.punctuation": "Smart Nepali punctuation",
    "preferences.optionLayer": "Traditional Option-key layer",
    "preferences.strictness": "Transliteration strictness",
    "preferences.mixed": "English preserve preference",
    "preferences.halanta": "Halanta behavior",
    "preferences.export": "Export JSON",
    "preferences.save": "Save edited TSV",
    "preferences.delete": "Delete personal dictionary",
    "preferences.refresh": "Refresh",
    "preferences.close": "Close",
    "tutorial.title": "नमस्ते टाइप गर्नुहोस्",
    "tutorial.body": "Lekh छानेपछि namaste लेख्नुहोस्। Inline preview नमस्ते देखिन्छ, Space थिच्दा कमिट हुन्छ। Control-Option-Space ले मोड छान्छ।",
    "diagnostics.privacy": "Privacy: text, key values, and secure input are never written to diagnostics."
  ]

  private static let en: [String: String] = [
    "app.name": "Lekh Keyboard",
    "menu.preferences": "Lekh Preferences...",
    "menu.tutorial": "First Run Tutorial...",
    "menu.diagnostics": "Diagnostics...",
    "menu.dictionaryWarning": "Dictionary Update Warning...",
    "menu.forgetCandidate": "Forget Current Candidate",
    "mode.romanizedRomanized": "Romanized-Romanized",
    "mode.romanizedTraditional": "Romanized-Traditional",
    "mode.traditionalTraditional": "Traditional-Traditional",
    "mode.traditionalRomanized": "Traditional-Romanized",
    "mode.prompt": "Choose Lekh mode",
    "candidate.badge.unicode": "Unicode",
    "candidate.badge.roman": "Roman",
    "candidate.badge.fix": "Fix",
    "candidate.badge.helper": "Helper",
    "candidate.explain.unicode": "Press Space to commit this Devanagari preview.",
    "candidate.explain.roman": "Romanized helper form.",
    "candidate.explain.fix": "Proofread suggestion: replace the typed word with this correction.",
    "preferences.title": "Lekh Preferences",
    "preferences.typing": "Typing",
    "preferences.personal": "Personal Dictionary",
    "preferences.diagnostics": "Diagnostics",
    "preferences.tutorial": "Tutorial",
    "preferences.inline": "Inline Devanagari preview",
    "preferences.inlineAlwaysOn": "Inline preview is always on for live typing.",
    "preferences.candidates": "Custom candidate window",
    "preferences.proofread": "Proofread-as-you-type",
    "preferences.punctuation": "Smart Nepali punctuation",
    "preferences.optionLayer": "Traditional Option-key layer",
    "preferences.strictness": "Transliteration strictness",
    "preferences.mixed": "English preserve preference",
    "preferences.halanta": "Halanta behavior",
    "preferences.export": "Export JSON",
    "preferences.save": "Save edited TSV",
    "preferences.delete": "Delete personal dictionary",
    "preferences.refresh": "Refresh",
    "preferences.close": "Close",
    "tutorial.title": "Type namaste",
    "tutorial.body": "After selecting Lekh, type namaste. The inline preview shows नमस्ते; Space commits it. Control-Option-Space opens the mode chooser.",
    "diagnostics.privacy": "Privacy: text, key values, and secure input are never written to diagnostics."
  ]

  public static func text(_ key: String) -> String {
    let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
    if language.hasPrefix("ne"), let value = ne[key] {
      return value
    }
    return en[key] ?? key
  }
}
