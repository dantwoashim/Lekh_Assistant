import Foundation

public enum LekhNativePreferences {
  public enum Keys {
    public static let inlinePreviewEnabled = "LekhInlinePreviewEnabled"
    public static let customCandidatePanelEnabled = "LekhCustomCandidatePanelEnabled"
    public static let proofreadAsYouTypeEnabled = "LekhProofreadAsYouTypeEnabled"
    public static let smartPunctuationEnabled = "LekhSmartPunctuationEnabled"
    public static let traditionalOptionLayerEnabled = "LekhTraditionalOptionLayerEnabled"
    public static let nextWordPredictionEnabled = "LekhNextWordPredictionEnabled"
    public static let transliterationStrictness = "LekhTransliterationStrictness"
    public static let mixedScriptPreference = "LekhMixedScriptPreference"
    public static let halantaBehavior = "LekhHalantaBehavior"
    public static let firstRunTutorialSeen = "LekhFirstRunTutorialSeen.v1"
  }

  public static func registerDefaults() {
    UserDefaults.standard.register(defaults: [
      Keys.inlinePreviewEnabled: true,
      Keys.customCandidatePanelEnabled: true,
      Keys.proofreadAsYouTypeEnabled: true,
      Keys.smartPunctuationEnabled: true,
      Keys.traditionalOptionLayerEnabled: true,
      Keys.nextWordPredictionEnabled: true,
      Keys.transliterationStrictness: 0.55,
      Keys.mixedScriptPreference: 0.50,
      Keys.halantaBehavior: "smart",
      Keys.firstRunTutorialSeen: false
    ])
  }

  public static var inlinePreviewEnabled: Bool {
    value(defaultKey: Keys.inlinePreviewEnabled, defaultValue: true)
  }

  public static var customCandidatePanelEnabled: Bool {
    value(defaultKey: Keys.customCandidatePanelEnabled, defaultValue: true)
  }

  public static var proofreadAsYouTypeEnabled: Bool {
    value(defaultKey: Keys.proofreadAsYouTypeEnabled, defaultValue: true)
  }

  public static var smartPunctuationEnabled: Bool {
    value(defaultKey: Keys.smartPunctuationEnabled, defaultValue: true)
  }

  public static var traditionalOptionLayerEnabled: Bool {
    value(defaultKey: Keys.traditionalOptionLayerEnabled, defaultValue: true)
  }

  public static var transliterationStrictness: Double {
    boundedDouble(key: Keys.transliterationStrictness, fallback: 0.55)
  }

  public static var mixedScriptPreference: Double {
    boundedDouble(key: Keys.mixedScriptPreference, fallback: 0.50)
  }

  public static var halantaBehavior: String {
    let behavior = UserDefaults.standard.string(forKey: Keys.halantaBehavior) ?? "smart"
    return ["smart", "explicit", "soft"].contains(behavior) ? behavior : "smart"
  }

  public static var firstRunTutorialSeen: Bool {
    get { value(defaultKey: Keys.firstRunTutorialSeen, defaultValue: false) }
    set { UserDefaults.standard.set(newValue, forKey: Keys.firstRunTutorialSeen) }
  }

  private static func value(defaultKey key: String, defaultValue: Bool) -> Bool {
    if UserDefaults.standard.object(forKey: key) == nil {
      return defaultValue
    }
    return UserDefaults.standard.bool(forKey: key)
  }

  private static func boundedDouble(key: String, fallback: Double) -> Double {
    if UserDefaults.standard.object(forKey: key) == nil {
      return fallback
    }
    return max(0, min(1, UserDefaults.standard.double(forKey: key)))
  }
}

public enum LekhMixedScriptPolicy {
  private static let protectedTokens: Set<String> = [
    "api", "otp", "pan", "pdf", "url", "http", "https", "email", "gmail", "icloud",
    "login", "username", "password", "wifi", "wi-fi", "qr", "id", "pin", "cvv",
    "esewa", "khalti", "ime", "ntc", "ncell", "tiktok", "whatsapp", "viber",
    "zoom", "teams", "slack", "github", "git", "xcode", "swift", "json", "csv"
  ]

  private static let conversationalLoanwords: Set<String> = [
    "office", "hospital", "school", "college", "meeting", "message", "phone",
    "video", "photo", "market", "bus", "taxi", "doctor", "file", "report"
  ]

  public static func preserveCandidate(for normalizedInput: String) -> String? {
    let token = normalizedInput.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !token.isEmpty, token.range(of: #"^[a-z0-9.+_-]+$"#, options: .regularExpression) != nil else {
      return nil
    }

    if token.contains("@") || token.range(of: #"^\+?\d[\d ._-]{3,}$"#, options: .regularExpression) != nil {
      return normalizedInput
    }
    if protectedTokens.contains(token) {
      return normalizedInput
    }

    let preference = LekhNativePreferences.mixedScriptPreference
    if preference >= 0.70, conversationalLoanwords.contains(token) {
      return normalizedInput
    }
    if preference <= 0.25 {
      return nil
    }
    return nil
  }
}
