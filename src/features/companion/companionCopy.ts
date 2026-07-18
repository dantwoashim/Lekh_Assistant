export type BooleanPreferenceKey = Exclude<
  keyof LekhNativePreferences,
  "nativeTypingMode" | "excludedApplicationBundleIdentifiers"
>;

export type CompanionLocale = "en" | "ne";
export type CompanionSection = "typing" | "privacy" | "updates";
export type ActivationPhase = "missing" | "installed" | "enabled" | "selected";

type ModeCopy = {
  title: string;
  description: string;
  input: string;
  output: string;
  badge?: string;
};

export type CompanionCopy = {
  localeLabel: string;
  productName: string;
  companionName: string;
  sections: Record<CompanionSection, [string, string]>;
  unavailableNoBridge: string;
  unavailableReadFailure: string;
  loadingTitle: string;
  loadingBody: string;
  retry: string;
  saving: string;
  saved: string;
  savedMode: string;
  saveError: string;
  excludedSaved: string;
  excludedError: string;
  signedFeedFailed: string;
  updateVerified: (version: string) => string;
  updateArchiveFailed: string;
  refresh: string;
  revealInstallation: string;
  keyboardSettings: string;
  checkAgain: string;
  showInputMethodsFolder: string;
  activation: Record<ActivationPhase, { title: string; body: string; state: string }>;
  windowsActivation: Record<ActivationPhase, { title: string; body: string; state: string }>;
  activationProgress: string;
  activationSteps: [string, string, string];
  windowsActivationSteps: [string, string, string];
  versionLine: (status: LekhNativeStatus) => string;
  ghostTitle: string;
  ghostBody: string;
  ghostOff: string;
  ghostTry: string;
  ghostTypedLabel: string;
  ghostHint: string;
  replay: string;
  spaceSafety: string;
  quickGuide: string;
  shortcuts: Array<[string, string, string]>;
  chooseMode: string;
  chooseModeBody: string;
  modes: Record<LekhNativePreferences["nativeTypingMode"], ModeCopy>;
  modeMenuShortcut: string;
  advancedTitle: string;
  advancedBody: string;
  preferences: Record<BooleanPreferenceKey, [string, string]>;
  privacyHeroTitle: string;
  privacyHeroBody: string;
  privacyPromises: Array<[string, string]>;
  learningTitle: string;
  learningBody: string;
  neverLearn: string;
  neverLearnBody: string;
  noExcludedApps: string;
  addApplications: string;
  removeApplication: (name: string) => string;
  advancedBundleTitle: string;
  bundleIdentifierPlaceholder: string;
  add: string;
  localOnly: string;
  secureFields: string;
  updateTitle: string;
  updateBody: string;
  checking: string;
  checkForUpdates: string;
  downloadAndVerify: string;
  currentVersion: string;
  nativeVersion: string;
  architecture: string;
  signature: string;
  signatureVerified: string;
  developmentBuild: string;
  notInstalled: string;
  diagnosticsTitle: string;
  diagnosticsBody: string;
  updateSafety: Array<[string, string]>;
  windowsValidationTitle: string;
  windowsValidationBody: string;
  exclusionsUnavailable: string;
};

export const copyByLocale: Record<CompanionLocale, CompanionCopy> = {
  en: {
    localeLabel: "Language",
    productName: "Lekh Keyboard",
    companionName: "Companion",
    sections: {
      typing: ["Typing", "Make Lekh feel natural in every app."],
      privacy: ["Privacy", "Control what the keyboard can remember."],
      updates: ["Updates & diagnostics", "Keep this device healthy and current."]
    },
    unavailableNoBridge: "These controls are available only in the Lekh companion app.",
    unavailableReadFailure: "Lekh could not read the native keyboard status on this Mac.",
    loadingTitle: "Checking your keyboard",
    loadingBody: "Reading the installed input source and local preferences…",
    retry: "Try Again",
    saving: "Saving…",
    saved: "Saved on this device",
    savedMode: "Mode saved. It applies the next time Lekh activates.",
    saveError: "That change could not be saved. Your previous setting was restored.",
    excludedSaved: "Privacy exclusions saved on this Mac.",
    excludedError: "Use a complete bundle identifier, such as com.example.Editor.",
    signedFeedFailed: "The signed update feed could not be verified.",
    updateVerified: (version) => `Verified Lekh ${version} and revealed it in Finder.`,
    updateArchiveFailed: "The update could not be downloaded and verified.",
    refresh: "Refresh keyboard status",
    revealInstallation: "Reveal keyboard installation",
    keyboardSettings: "Open Keyboard Settings",
    checkAgain: "Check Again",
    showInputMethodsFolder: "Show Input Methods Folder",
    activation: {
      missing: {
        title: "Install the native keyboard",
        body: "The Lekh input method is not in your user Input Methods folder yet.",
        state: "Not installed"
      },
      installed: {
        title: "One quick step left",
        body: "Add Lekh in Keyboard Settings › Text Input › Edit, then return here.",
        state: "Needs setup"
      },
      enabled: {
        title: "Lekh is ready",
        body: "From the menu bar input menu, choose Lekh Keyboard to start typing.",
        state: "Ready to select"
      },
      selected: {
        title: "Lekh is active",
        body: "Open any text field and type normally. Your settings apply everywhere Lekh is selected.",
        state: "Active now"
      }
    },
    windowsActivation: {
      missing: {
        title: "Native Windows keyboard unavailable",
        body: "This companion package does not contain a Lekh Text Services Framework DLL. It cannot type system-wide.",
        state: "Companion only"
      },
      installed: {
        title: "Windows text service found",
        body: "The native DLL is packaged but its text-service profile is not registered for this account.",
        state: "Registration needed"
      },
      enabled: {
        title: "Windows text service registered",
        body: "Press Windows–Space and choose Lekh Keyboard Nepali. Active-source detection still requires Windows host validation.",
        state: "Registered"
      },
      selected: {
        title: "Lekh is active",
        body: "The Windows text service is selected for the current text field.",
        state: "Active now"
      }
    },
    activationProgress: "Activation progress",
    activationSteps: ["Installed", "Added", "Active"],
    windowsActivationSteps: ["Packaged", "Registered", "Selected"],
    versionLine: (status) => `Native keyboard ${status.version ?? "version unknown"}`,
    ghostTitle: "Finish words without losing your flow",
    ghostBody: "A quiet gray completion appears beside the word you are composing. Nothing is inserted until you accept it.",
    ghostOff: "Ghost suggestions are off. Turn them on to see gentle word completions while typing.",
    ghostTry: "Try this anywhere Lekh is active",
    ghostTypedLabel: "You type swas",
    ghostHint: "accepts the gray ending",
    replay: "Replay preview",
    spaceSafety: "Space always keeps exactly what you typed.",
    quickGuide: "The four moves worth remembering",
    shortcuts: [
      ["Tab  →", "Accept", "Use the visible gray completion"],
      ["↑  ↓", "Browse", "Move through alternate words"],
      ["1–8", "Choose", "Pick a numbered candidate directly"],
      ["Esc", "Dismiss", "Return safely to your source text"]
    ],
    chooseMode: "Choose how you write",
    chooseModeBody: "Use plain-language modes here, or switch instantly from the Lekh input menu.",
    modes: {
      "romanized-traditional": {
        title: "English letters → नेपाली",
        description: "Type Nepali by sound and get Unicode Nepali.",
        input: "namaste",
        output: "नमस्ते",
        badge: "Recommended"
      },
      "romanized-romanized": {
        title: "Romanized Nepali",
        description: "Keep Latin letters while Lekh improves word ranking.",
        input: "swasthya",
        output: "swasthya"
      },
      "traditional-traditional": {
        title: "नेपाली spelling help",
        description: "Keep Unicode Nepali and receive local corrections.",
        input: "स्वास्थ",
        output: "स्वास्थ्य"
      },
      "traditional-romanized": {
        title: "नेपाली → English letters",
        description: "Turn a Nepali-script word into a Romanized helper.",
        input: "स्वास्थ्य",
        output: "swasthya"
      }
    },
    modeMenuShortcut: "Press ⌃⌥Space for the mode menu, or ⌃⌥1–4 to switch directly.",
    advancedTitle: "Advanced typing controls",
    advancedBody: "Candidate display, language tools, and contextual ranking",
    preferences: {
      inlinePreviewEnabled: ["Ghost suggestions", "Show a gray completion beside the active word."],
      customCandidatePanelEnabled: ["Candidate list", "Show alternate words beneath the insertion point."],
      proofreadAsYouTypeEnabled: ["Nepali spelling help", "Suggest local corrections for Unicode Nepali input."],
      smartPunctuationEnabled: ["Nepali punctuation", "Use danda automatically in Nepali output modes."],
      personalizationEnabled: ["Personal learning", "Improve ranking only from words you explicitly choose."],
      nextWordPredictionEnabled: ["Context-aware ranking", "Use the previous word to improve candidate order."]
    },
    privacyHeroTitle: "Your typing stays yours",
    privacyHeroBody: "Lekh’s native engine works locally. It does not need a network connection or this companion window while you type.",
    privacyPromises: [
      ["No keystroke network calls", "The typing path has no synchronous network or companion dependency."],
      ["Secure fields stay untouched", "Password and secure-entry fields bypass composition and learning."],
      ["No raw key log", "Learning records an explicit word choice, never a stream of physical keys."],
      ["You stay in control", "Turn learning off, or exclude specific applications at any time."]
    ],
    learningTitle: "Personal learning",
    learningBody: "Remember only the words you deliberately choose, on this device.",
    neverLearn: "Never learn in",
    neverLearnBody: "Choose applications where Lekh should type normally but never update personal ranking.",
    noExcludedApps: "No applications excluded",
    addApplications: "Choose Applications…",
    removeApplication: (name) => `Remove ${name} from privacy exclusions`,
    advancedBundleTitle: "Add by bundle identifier",
    bundleIdentifierPlaceholder: "com.example.Editor",
    add: "Add",
    localOnly: "On-device only",
    secureFields: "Secure fields protected",
    updateTitle: "Signed, deliberate updates",
    updateBody: "Lekh checks only when you ask. Production downloads must pass the pinned host, SHA-256, and Ed25519 checks before Finder reveals them.",
    checking: "Checking…",
    checkForUpdates: "Check for Updates",
    downloadAndVerify: "Download & Verify",
    currentVersion: "Companion",
    nativeVersion: "Native keyboard",
    architecture: "Architecture",
    signature: "Release signature",
    signatureVerified: "Release signature verified",
    developmentBuild: "Development build",
    notInstalled: "Not installed",
    diagnosticsTitle: "Installation diagnostics",
    diagnosticsBody: "Status only—diagnostics never include typed text or personal vocabulary.",
    updateSafety: [
      ["Manual by default", "No background download starts from this screen."],
      ["Pinned source", "Update archives must remain on Lekh’s configured HTTPS host."],
      ["Double verification", "Every archive must match its hash and Ed25519 signature."]
    ],
    windowsValidationTitle: "Windows native typing is still in validation",
    windowsValidationBody: "This companion can report the packaged text service, but its settings are not connected to the Windows typing path yet. Controls stay unavailable instead of pretending to work.",
    exclusionsUnavailable: "Per-application learning exclusions are not connected to the Windows text service yet. This development path makes no claim that personal learning is active."
  },
  ne: {
    localeLabel: "भाषा",
    productName: "Lekh Keyboard",
    companionName: "साथी एप",
    sections: {
      typing: ["टाइपिङ", "हरेक एपमा Lekh लाई सहज बनाउनुहोस्।"],
      privacy: ["गोपनीयता", "किबोर्डले के सम्झन सक्छ भन्ने नियन्त्रण गर्नुहोस्।"],
      updates: ["अपडेट र निदान", "यो Mac लाई स्वस्थ र अद्यावधिक राख्नुहोस्।"]
    },
    unavailableNoBridge: "यी नियन्त्रणहरू Lekh साथी एपमा मात्र उपलब्ध छन्।",
    unavailableReadFailure: "Lekh ले यो Mac को नेटिभ किबोर्ड स्थिति पढ्न सकेन।",
    loadingTitle: "किबोर्ड जाँच हुँदैछ",
    loadingBody: "इन्स्टल गरिएको input source र स्थानीय सेटिङ पढ्दै…",
    retry: "फेरि प्रयास",
    saving: "सेभ हुँदै…",
    saved: "यो Mac मा सेभ भयो",
    savedMode: "मोड सेभ भयो। Lekh फेरि सक्रिय हुँदा लागू हुन्छ।",
    saveError: "परिवर्तन सेभ भएन। अघिल्लो सेटिङ फिर्ता राखिएको छ।",
    excludedSaved: "गोपनीयता बहिष्करण यो Mac मा सेभ भयो।",
    excludedError: "com.example.Editor जस्तो पूरा bundle identifier प्रयोग गर्नुहोस्।",
    signedFeedFailed: "हस्ताक्षरित अपडेट फिड प्रमाणित भएन।",
    updateVerified: (version) => `Lekh ${version} प्रमाणित गरेर Finder मा देखाइयो।`,
    updateArchiveFailed: "अपडेट डाउनलोड र प्रमाणित गर्न सकिएन।",
    refresh: "किबोर्ड स्थिति रिफ्रेस",
    revealInstallation: "किबोर्ड इन्स्टलेशन देखाउनुहोस्",
    keyboardSettings: "Keyboard Settings खोल्नुहोस्",
    checkAgain: "फेरि जाँच्नुहोस्",
    showInputMethodsFolder: "Input Methods फोल्डर देखाउनुहोस्",
    activation: {
      missing: {
        title: "नेटिभ किबोर्ड इन्स्टल गर्नुहोस्",
        body: "Lekh input method अझै तपाईंको Input Methods फोल्डरमा छैन।",
        state: "इन्स्टल छैन"
      },
      installed: {
        title: "अब एउटा सानो चरण बाँकी",
        body: "Keyboard Settings › Text Input › Edit मा Lekh थपेर यहाँ फर्कनुहोस्।",
        state: "सेटअप बाँकी"
      },
      enabled: {
        title: "Lekh तयार छ",
        body: "टाइप गर्न मेनु बारको input menu बाट Lekh Keyboard छान्नुहोस्।",
        state: "छान्न तयार"
      },
      selected: {
        title: "Lekh सक्रिय छ",
        body: "कुनै पनि text field खोल्नुहोस् र सामान्य रूपमा टाइप गर्नुहोस्।",
        state: "अहिले सक्रिय"
      }
    },
    windowsActivation: {
      missing: {
        title: "नेटिभ Windows किबोर्ड उपलब्ध छैन",
        body: "यो companion package मा Lekh Text Services Framework DLL छैन। यसले system-wide टाइप गर्न सक्दैन।",
        state: "Companion मात्र"
      },
      installed: {
        title: "Windows text service भेटियो",
        body: "नेटिभ DLL package मा छ तर यो account का लागि text-service profile दर्ता भएको छैन।",
        state: "दर्ता आवश्यक"
      },
      enabled: {
        title: "Windows text service दर्ता छ",
        body: "Windows–Space थिचेर Lekh Keyboard Nepali छान्नुहोस्। Active-source detection लाई अझै Windows host validation चाहिन्छ।",
        state: "दर्ता छ"
      },
      selected: {
        title: "Lekh सक्रिय छ",
        body: "हालको text field मा Windows text service छानिएको छ।",
        state: "अहिले सक्रिय"
      }
    },
    activationProgress: "सक्रिय गर्ने प्रगति",
    activationSteps: ["इन्स्टल", "थपियो", "सक्रिय"],
    windowsActivationSteps: ["Packaged", "दर्ता", "छानिएको"],
    versionLine: (status) => `नेटिभ किबोर्ड ${status.version ?? "संस्करण अज्ञात"}`,
    ghostTitle: "लय नटुटाई शब्द पूरा गर्नुहोस्",
    ghostBody: "बनिरहेको शब्दसँगै हल्का खैरो पूर्णता देखिन्छ। तपाईंले स्वीकार नगरेसम्म केही पनि घुस्दैन।",
    ghostOff: "घोस्ट सुझाव बन्द छ। टाइप गर्दा हल्का शब्द पूर्णता हेर्न यसलाई खोल्नुहोस्।",
    ghostTry: "Lekh सक्रिय भएको ठाउँमा यसरी प्रयास गर्नुहोस्",
    ghostTypedLabel: "तपाईं swas टाइप गर्नुहुन्छ",
    ghostHint: "थिच्दा खैरो भाग स्वीकारिन्छ",
    replay: "पूर्वावलोकन फेरि चलाउनुहोस्",
    spaceSafety: "Space ले सधैं तपाईंले टाइप गरेकै कुरा राख्छ।",
    quickGuide: "सम्झन लायक चार चाल",
    shortcuts: [
      ["Tab  →", "स्वीकार", "देखिएको खैरो पूर्णता प्रयोग"],
      ["↑  ↓", "हेर्नुहोस्", "वैकल्पिक शब्दहरूमा सर्नुहोस्"],
      ["1–8", "छान्नुहोस्", "नम्बर भएको candidate सीधै छान्नुहोस्"],
      ["Esc", "हटाउनुहोस्", "सुरक्षित रूपमा source text मा फर्कनुहोस्"]
    ],
    chooseMode: "कसरी लेख्ने छान्नुहोस्",
    chooseModeBody: "यहाँ सजिलो भाषामा मोड छान्नुहोस् वा Lekh input menu बाट तुरुन्त बदल्नुहोस्।",
    modes: {
      "romanized-traditional": {
        title: "English अक्षर → नेपाली",
        description: "नेपाली उच्चारणअनुसार टाइप गरेर Unicode नेपाली पाउनुहोस्।",
        input: "namaste",
        output: "नमस्ते",
        badge: "सिफारिस"
      },
      "romanized-romanized": {
        title: "Romanized नेपाली",
        description: "Latin अक्षर राखेर शब्दको क्रम सुधार्नुहोस्।",
        input: "swasthya",
        output: "swasthya"
      },
      "traditional-traditional": {
        title: "नेपाली हिज्जे सहायता",
        description: "Unicode नेपाली राखेर स्थानीय सुधार पाउनुहोस्।",
        input: "स्वास्थ",
        output: "स्वास्थ्य"
      },
      "traditional-romanized": {
        title: "नेपाली → English अक्षर",
        description: "नेपाली शब्दको Romanized सहायक पाउनुहोस्।",
        input: "स्वास्थ्य",
        output: "swasthya"
      }
    },
    modeMenuShortcut: "मोड menu का लागि ⌃⌥Space, वा सीधै बदल्न ⌃⌥1–4 थिच्नुहोस्।",
    advancedTitle: "उन्नत टाइपिङ नियन्त्रण",
    advancedBody: "Candidate, भाषा उपकरण र सन्दर्भअनुसार क्रम",
    preferences: {
      inlinePreviewEnabled: ["घोस्ट सुझाव", "सक्रिय शब्दसँगै खैरो पूर्णता देखाउनुहोस्।"],
      customCandidatePanelEnabled: ["Candidate सूची", "कर्सरमुनि वैकल्पिक शब्दहरू देखाउनुहोस्।"],
      proofreadAsYouTypeEnabled: ["नेपाली हिज्जे सहायता", "Unicode नेपाली input का स्थानीय सुधार सुझाउनुहोस्।"],
      smartPunctuationEnabled: ["नेपाली विरामचिह्न", "नेपाली output mode मा डण्डा स्वतः प्रयोग गर्नुहोस्।"],
      personalizationEnabled: ["व्यक्तिगत सिकाइ", "तपाईंले स्पष्ट छानेका शब्दबाट मात्र क्रम सुधार्नुहोस्।"],
      nextWordPredictionEnabled: ["सन्दर्भअनुसार क्रम", "अघिल्लो शब्दबाट candidate क्रम सुधार्नुहोस्।"]
    },
    privacyHeroTitle: "तपाईंको टाइपिङ तपाईंकै रहन्छ",
    privacyHeroBody: "Lekh को नेटिभ engine स्थानीय रूपमा चल्छ। टाइप गर्दा network वा यो साथी झ्याल चाहिँदैन।",
    privacyPromises: [
      ["Keystroke को network call छैन", "टाइपिङ path मा synchronous network वा companion dependency छैन।"],
      ["Secure field नछोइने", "Password र secure-entry field ले composition र learning bypass गर्छ।"],
      ["Raw key log छैन", "Learning ले explicit शब्द छनोट मात्र राख्छ, physical key stream होइन।"],
      ["नियन्त्रण तपाईंकै", "Learning बन्द वा निश्चित एप बहिष्करण जहिले पनि गर्न सकिन्छ।"]
    ],
    learningTitle: "व्यक्तिगत सिकाइ",
    learningBody: "तपाईंले जानाजानी छानेका शब्द मात्र यही device मा सम्झनुहोस्।",
    neverLearn: "यी एपमा कहिल्यै नसिक्ने",
    neverLearnBody: "Lekh ले सामान्य टाइप गरोस् तर व्यक्तिगत क्रम कहिल्यै नबदलियोस् भन्ने एप छान्नुहोस्।",
    noExcludedApps: "कुनै एप बहिष्कृत छैन",
    addApplications: "एप छान्नुहोस्…",
    removeApplication: (name) => `गोपनीयता बहिष्करणबाट ${name} हटाउनुहोस्`,
    advancedBundleTitle: "Bundle identifier बाट थप्नुहोस्",
    bundleIdentifierPlaceholder: "com.example.Editor",
    add: "थप्नुहोस्",
    localOnly: "यही device मा मात्र",
    secureFields: "Secure field सुरक्षित",
    updateTitle: "हस्ताक्षरित, नियन्त्रित अपडेट",
    updateBody: "Lekh ले तपाईंले भनेपछि मात्र जाँच गर्छ। Finder मा देखाउनुअघि production download ले pinned host, SHA-256 र Ed25519 जाँच पास गर्नुपर्छ।",
    checking: "जाँच हुँदै…",
    checkForUpdates: "अपडेट जाँच्नुहोस्",
    downloadAndVerify: "डाउनलोड र प्रमाणित",
    currentVersion: "साथी एप",
    nativeVersion: "नेटिभ किबोर्ड",
    architecture: "Architecture",
    signature: "Release signature",
    signatureVerified: "Release signature प्रमाणित",
    developmentBuild: "Development build",
    notInstalled: "इन्स्टल छैन",
    diagnosticsTitle: "इन्स्टलेशन निदान",
    diagnosticsBody: "स्थिति मात्र—निदानमा टाइप गरिएको text वा व्यक्तिगत शब्दावली पर्दैन।",
    updateSafety: [
      ["पूर्वनिर्धारित रूपमा manual", "यो screen बाट background download सुरु हुँदैन।"],
      ["Pinned source", "Update archive Lekh को configured HTTPS host मै हुनुपर्छ।"],
      ["दोहोरो प्रमाणिकरण", "हरेक archive को hash र Ed25519 signature मिल्नुपर्छ।"]
    ],
    windowsValidationTitle: "Windows को नेटिभ टाइपिङ अझै validation मा छ",
    windowsValidationBody: "यो साथी एपले packaged text service को स्थिति देखाउन सक्छ, तर यसको settings अझै Windows typing path मा जोडिएको छैन। काम गरेको नाटक गर्नुको सट्टा controls उपलब्ध हुँदैनन्।",
    exclusionsUnavailable: "प्रति-एप learning exclusion अझै Windows text service मा जोडिएको छैन। यो development path ले personal learning सक्रिय भएको दाबी गर्दैन।"
  }
};

export const modeOrder: LekhNativePreferences["nativeTypingMode"][] = [
  "romanized-traditional",
  "romanized-romanized",
  "traditional-traditional",
  "traditional-romanized"
];

export const advancedPreferenceOrder: BooleanPreferenceKey[] = [
  "customCandidatePanelEnabled",
  "nextWordPredictionEnabled",
  "proofreadAsYouTypeEnabled",
  "smartPunctuationEnabled"
];
