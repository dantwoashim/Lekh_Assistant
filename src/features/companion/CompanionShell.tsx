import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  Command,
  FolderOpen,
  Info,
  Keyboard,
  Languages,
  LockKeyhole,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  WifiOff
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

type BooleanPreferenceKey = Exclude<
  keyof LekhNativePreferences,
  "nativeTypingMode" | "excludedApplicationBundleIdentifiers"
>;

type CompanionLocale = "en" | "ne";
type CompanionSection = "typing" | "privacy" | "updates";
type ActivationPhase = "missing" | "installed" | "enabled" | "selected";
type NoticeTone = "success" | "error" | "neutral";

type ModeCopy = {
  title: string;
  description: string;
  input: string;
  output: string;
  badge?: string;
};

type CompanionCopy = {
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

const copyByLocale: Record<CompanionLocale, CompanionCopy> = {
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

const modeOrder: LekhNativePreferences["nativeTypingMode"][] = [
  "romanized-traditional",
  "romanized-romanized",
  "traditional-traditional",
  "traditional-romanized"
];

const advancedPreferenceOrder: BooleanPreferenceKey[] = [
  "customCandidatePanelEnabled",
  "nextWordPredictionEnabled",
  "proofreadAsYouTypeEnabled",
  "smartPunctuationEnabled"
];

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: "noBridge" | "readFailure" }
  | { kind: "ready"; status: LekhNativeStatus; preferences: LekhNativePreferences };

function detectCompanionLocale(): CompanionLocale {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem("lekh.companion.locale");
    if (stored === "en" || stored === "ne") return stored;
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ne")
    ? "ne"
    : "en";
}

function detectCompanionSection(): CompanionSection {
  if (typeof window === "undefined") return "typing";
  const stored = window.localStorage.getItem("lekh.companion.section");
  return stored === "privacy" || stored === "updates" ? stored : "typing";
}

function activationPhase(status: LekhNativeStatus | null): ActivationPhase {
  if (!status?.installed) return "missing";
  if (!status.enabled) return "installed";
  return status.selected ? "selected" : "enabled";
}

function friendlyIdentifier(identifier: string): string {
  const parts = identifier.split(".");
  const finalPart = parts[parts.length - 1] ?? identifier;
  return finalPart.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
}

function Switch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="switch-control">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span aria-hidden="true" />
    </span>
  );
}

function SettingRow({
  title,
  description,
  checked,
  disabled,
  onChange
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="preference-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <Switch checked={checked} disabled={disabled} label={title} onChange={onChange} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="diagnostic-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function CompanionShell() {
  const [locale, setLocale] = useState<CompanionLocale>(() => detectCompanionLocale());
  const [activeSection, setActiveSection] = useState<CompanionSection>(() => detectCompanionSection());
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingPreferences, setPendingPreferences] = useState<Set<BooleanPreferenceKey>>(new Set());
  const [modePending, setModePending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<LekhUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [manualIdentifier, setManualIdentifier] = useState("");
  const [applicationNames, setApplicationNames] = useState<Record<string, string>>({});
  const [demoSequence, setDemoSequence] = useState(0);
  const noticeTimer = useRef<number | null>(null);
  const copy = copyByLocale[locale];

  const refresh = useCallback(async () => {
    const bridge = window.lekhDesktop;
    if (!bridge) {
      setState({ kind: "unavailable", reason: "noBridge" });
      return;
    }
    try {
      const [status, preferences] = await Promise.all([
        bridge.getStatus(),
        bridge.readPreferences()
      ]);
      setState({ kind: "ready", status, preferences });
    } catch {
      setState({ kind: "unavailable", reason: "readFailure" });
    }
  }, []);

  const showNotice = useCallback((message: string, tone: NoticeTone = "neutral") => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ message, tone });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (state.kind !== "ready" || state.status.selected) return;
    const interval = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(interval);
  }, [refresh, state]);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    document.title = `${copy.sections[activeSection][0]} — ${copy.productName}`;
  }, [activeSection, copy]);

  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>(".companion-content");
    if (content) content.scrollTop = 0;
  }, [activeSection, state.kind]);

  function chooseLocale(nextLocale: CompanionLocale) {
    setLocale(nextLocale);
    window.localStorage.setItem("lekh.companion.locale", nextLocale);
  }

  function chooseSection(section: CompanionSection) {
    setActiveSection(section);
    window.localStorage.setItem("lekh.companion.section", section);
  }

  async function updatePreference(key: BooleanPreferenceKey, value: boolean) {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    const previousValue = state.preferences[key];
    setPendingPreferences((current) => new Set(current).add(key));
    setState((current) => current.kind === "ready"
      ? { ...current, preferences: { ...current.preferences, [key]: value } }
      : current);
    try {
      await window.lekhDesktop.updatePreferences({ [key]: value });
      showNotice(copy.saved, "success");
    } catch {
      setState((current) => current.kind === "ready"
        ? { ...current, preferences: { ...current.preferences, [key]: previousValue } }
        : current);
      showNotice(copy.saveError, "error");
    } finally {
      setPendingPreferences((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function updateMode(nativeTypingMode: LekhNativePreferences["nativeTypingMode"]) {
    if (state.kind !== "ready" || !window.lekhDesktop || modePending) return;
    const previousMode = state.preferences.nativeTypingMode;
    setModePending(true);
    setState((current) => current.kind === "ready"
      ? { ...current, preferences: { ...current.preferences, nativeTypingMode } }
      : current);
    try {
      await window.lekhDesktop.updatePreferences({ nativeTypingMode });
      showNotice(copy.savedMode, "success");
    } catch {
      setState((current) => current.kind === "ready"
        ? { ...current, preferences: { ...current.preferences, nativeTypingMode: previousMode } }
        : current);
      showNotice(copy.saveError, "error");
    } finally {
      setModePending(false);
    }
  }

  async function saveExcludedApplications(identifiers: string[]) {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    const unique = Array.from(new Set(identifiers.map((item) => item.trim()).filter(Boolean)));
    if (unique.some((item) => !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(item))) {
      showNotice(copy.excludedError, "error");
      return;
    }
    const previous = state.preferences.excludedApplicationBundleIdentifiers;
    setState((current) => current.kind === "ready"
      ? {
          ...current,
          preferences: { ...current.preferences, excludedApplicationBundleIdentifiers: unique }
        }
      : current);
    try {
      await window.lekhDesktop.updatePreferences({ excludedApplicationBundleIdentifiers: unique });
      showNotice(copy.excludedSaved, "success");
    } catch {
      setState((current) => current.kind === "ready"
        ? {
            ...current,
            preferences: { ...current.preferences, excludedApplicationBundleIdentifiers: previous }
          }
        : current);
      showNotice(copy.excludedError, "error");
    }
  }

  async function chooseExcludedApplications() {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    let selected: LekhExcludedApplication[];
    try {
      selected = await window.lekhDesktop.chooseExcludedApplications();
    } catch {
      showNotice(copy.excludedError, "error");
      return;
    }
    if (selected.length === 0) return;
    setApplicationNames((current) => ({
      ...current,
      ...Object.fromEntries(selected.map((application) => [application.bundleIdentifier, application.displayName]))
    }));
    await saveExcludedApplications([
      ...state.preferences.excludedApplicationBundleIdentifiers,
      ...selected.map((application) => application.bundleIdentifier)
    ]);
  }

  function addManualIdentifier(event: FormEvent) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const identifier = manualIdentifier.trim();
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(identifier)) {
      showNotice(copy.excludedError, "error");
      return;
    }
    setManualIdentifier("");
    void saveExcludedApplications([
      ...state.preferences.excludedApplicationBundleIdentifiers,
      identifier
    ]);
  }

  async function checkForUpdates() {
    if (!window.lekhDesktop) return;
    setUpdateBusy(true);
    try {
      setUpdateStatus(await window.lekhDesktop.checkForUpdates());
    } catch {
      setUpdateStatus({ status: "disabled", message: copy.signedFeedFailed });
    } finally {
      setUpdateBusy(false);
    }
  }

  async function downloadUpdate() {
    if (!window.lekhDesktop) return;
    setUpdateBusy(true);
    try {
      const result = await window.lekhDesktop.downloadVerifiedUpdate();
      setUpdateStatus({ status: "current", message: copy.updateVerified(result.version) });
    } catch {
      setUpdateStatus({ status: "disabled", message: copy.updateArchiveFailed });
    } finally {
      setUpdateBusy(false);
    }
  }

  const status = state.kind === "ready" ? state.status : null;
  const preferences = state.kind === "ready" ? state.preferences : null;
  const phase = activationPhase(status);
  const isWindowsFallback = window.lekhDesktop?.platform === "win32";
  const activation = (isWindowsFallback ? copy.windowsActivation : copy.activation)[phase];
  const ghostEnabled = preferences?.inlinePreviewEnabled ?? false;
  const excludedApplications = preferences?.excludedApplicationBundleIdentifiers ?? [];
  const [sectionTitle, sectionSubtitle] = copy.sections[activeSection];
  const controlsDisabled = state.kind !== "ready" || !status?.installed || isWindowsFallback;
  const completedActivationSteps = phase === "selected" ? 3 : phase === "enabled" ? 2 : phase === "installed" ? 1 : 0;
  const activationSteps = isWindowsFallback ? copy.windowsActivationSteps : copy.activationSteps;

  function activationAction() {
    if (isWindowsFallback) return void window.lekhDesktop?.openKeyboardSettings();
    if (phase === "missing") return void window.lekhDesktop?.revealInputMethod();
    if (phase === "enabled") return void refresh();
    return void window.lekhDesktop?.openKeyboardSettings();
  }

  const activationActionLabel = isWindowsFallback
    ? copy.keyboardSettings
    : phase === "missing"
      ? copy.showInputMethodsFolder
      : phase === "enabled"
        ? copy.checkAgain
        : copy.keyboardSettings;

  return (
    <div className="companion-shell" lang={locale} aria-busy={state.kind === "loading"}>
      <aside className="companion-sidebar">
        <div className="companion-brand">
          <div className="companion-mark" aria-hidden="true">ले</div>
          <div>
            <strong>{copy.productName}</strong>
            <span>{copy.companionName}</span>
          </div>
        </div>

        <nav className="companion-navigation" aria-label={copy.companionName}>
          {([
            ["typing", Sparkles],
            ["privacy", ShieldCheck],
            ["updates", CloudDownload]
          ] as const).map(([section, Icon]) => (
            <button
              type="button"
              key={section}
              className={activeSection === section ? "is-active" : ""}
              aria-current={activeSection === section ? "page" : undefined}
              aria-controls={`companion-${section}-page`}
              onClick={() => chooseSection(section)}
            >
              <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
              <span>{copy.sections[section][0]}</span>
            </button>
          ))}
        </nav>

        <div className={`sidebar-health sidebar-health--${phase}`} aria-label={activation.state}>
          <span aria-hidden="true" />
          <div>
            <strong>{activation.state}</strong>
            <small>{status?.version ?? "Lekh"}</small>
          </div>
        </div>

        <label className="locale-selector">
          <Languages size={16} aria-hidden="true" />
          <span>{copy.localeLabel}</span>
          <select
            aria-label={copy.localeLabel}
            value={locale}
            onChange={(event) => chooseLocale(event.currentTarget.value as CompanionLocale)}
          >
            <option value="en">English</option>
            <option value="ne">नेपाली</option>
          </select>
        </label>
      </aside>

      <main className="companion-content">
        <header className="companion-header">
          <div className="companion-header-body">
            <h1>{sectionTitle}</h1>
            <p>{sectionSubtitle}</p>
          </div>
          <div className="companion-toolbar">
            <button type="button" title={copy.revealInstallation} onClick={() => void window.lekhDesktop?.revealInputMethod()}>
              <FolderOpen size={16} aria-hidden="true" />
              <span className="sr-only">{copy.revealInstallation}</span>
            </button>
            <button type="button" title={copy.refresh} onClick={() => void refresh()}>
              <RefreshCw size={16} aria-hidden="true" />
              <span className="sr-only">{copy.refresh}</span>
            </button>
          </div>
        </header>

        {state.kind === "loading" ? (
          <section className="companion-state-card" aria-live="polite">
            <span className="state-spinner" aria-hidden="true" />
            <h2>{copy.loadingTitle}</h2>
            <p>{copy.loadingBody}</p>
          </section>
        ) : null}

        {state.kind === "unavailable" ? (
          <section className="companion-state-card companion-state-card--error" role="alert">
            <Info size={24} aria-hidden="true" />
            <h2>{copy.activation.missing.title}</h2>
            <p>{state.reason === "noBridge" ? copy.unavailableNoBridge : copy.unavailableReadFailure}</p>
            <button type="button" className="button button--primary" onClick={() => void refresh()}>{copy.retry}</button>
          </section>
        ) : null}

        {state.kind === "ready" && activeSection === "typing" ? (
          <div className="companion-page" id="companion-typing-page">
            <section className={`activation-card activation-card--${phase}`} aria-labelledby="activation-title">
              <div className="activation-summary">
                <span className="activation-icon" aria-hidden="true">
                  {phase === "selected" ? <CheckCircle2 size={23} /> : <Keyboard size={22} />}
                </span>
                <div>
                  <div className="activation-heading-row">
                    <h2 id="activation-title">{activation.title}</h2>
                    <span className="state-pill">{activation.state}</span>
                  </div>
                  <p>{activation.body}</p>
                  {status?.installed ? <small>{copy.versionLine(status)}</small> : null}
                </div>
              </div>
              <div className="activation-actions">
                <button type="button" className="button button--primary" onClick={activationAction}>
                  {activationActionLabel}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
                {phase === "enabled" ? (
                  <button type="button" className="button button--quiet" onClick={() => void window.lekhDesktop?.openKeyboardSettings()}>
                    {copy.keyboardSettings}
                  </button>
                ) : null}
              </div>
              <ol className="activation-progress" aria-label={copy.activationProgress}>
                {activationSteps.map((step, index) => (
                  <li className={index < completedActivationSteps ? "is-complete" : index === completedActivationSteps ? "is-current" : ""} key={step}>
                    <span aria-hidden="true">{index < completedActivationSteps ? <Check size={12} /> : index + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
            </section>

            {isWindowsFallback ? (
              <aside className="platform-truth-note" role="note">
                <Info size={17} aria-hidden="true" />
                <div><strong>{copy.windowsValidationTitle}</strong><p>{copy.windowsValidationBody}</p></div>
              </aside>
            ) : null}

            <section className="experience-card" aria-labelledby="ghost-title">
              <div className="experience-copy">
                <div className="eyebrow"><Sparkles size={14} aria-hidden="true" /> {copy.ghostTry}</div>
                <h2 id="ghost-title">{copy.ghostTitle}</h2>
                <p>{ghostEnabled ? copy.ghostBody : copy.ghostOff}</p>
              </div>
              <Switch
                checked={ghostEnabled}
                disabled={controlsDisabled || pendingPreferences.has("inlinePreviewEnabled")}
                label={copy.preferences.inlinePreviewEnabled[0]}
                onChange={(checked) => void updatePreference("inlinePreviewEnabled", checked)}
              />
              <div className={`ghost-stage ${ghostEnabled ? "" : "is-disabled"}`}>
                <div className="ghost-stage__label">{copy.ghostTypedLabel}</div>
                <div className="ghost-word" key={demoSequence} aria-label="स्वास्थ्य">
                  <span>स्वा</span><span>स्थ्य</span>
                </div>
                <div className="ghost-acceptance">
                  <span><kbd>Tab</kbd><span className="key-or">or</span><kbd>→</kbd></span>
                  <small>{copy.ghostHint}</small>
                </div>
                <button
                  type="button"
                  className="replay-button"
                  disabled={!ghostEnabled}
                  onClick={() => setDemoSequence((value) => value + 1)}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  {copy.replay}
                </button>
              </div>
              <div className="safety-note"><ShieldCheck size={15} aria-hidden="true" /> {copy.spaceSafety}</div>
            </section>

            <section className="companion-card mode-card" aria-labelledby="mode-title">
              <div className="card-heading">
                <div>
                  <h2 id="mode-title">{copy.chooseMode}</h2>
                  <p>{copy.chooseModeBody}</p>
                </div>
                <Command size={19} aria-hidden="true" />
              </div>
              <div className="mode-grid" role="radiogroup" aria-labelledby="mode-title">
                {modeOrder.map((mode) => {
                  const modeCopy = copy.modes[mode];
                  const selected = preferences!.nativeTypingMode === mode;
                  return (
                    <label className={`mode-option ${selected ? "is-selected" : ""}`} key={mode}>
                      <input
                        type="radio"
                        name="native-typing-mode"
                        value={mode}
                        checked={selected}
                        disabled={controlsDisabled || modePending}
                        onChange={() => void updateMode(mode)}
                      />
                      <span className="mode-radio" aria-hidden="true"><span /></span>
                      <span className="mode-option__body">
                        <span className="mode-option__title">
                          <strong>{modeCopy.title}</strong>
                          {modeCopy.badge ? <em>{modeCopy.badge}</em> : null}
                        </span>
                        <small>{modeCopy.description}</small>
                        <span className="mode-example">
                          <code>{modeCopy.input}</code><ChevronRight size={12} aria-hidden="true" /><code>{modeCopy.output}</code>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="mode-shortcut"><Command size={14} aria-hidden="true" /> {copy.modeMenuShortcut}</p>
            </section>

            <section className="companion-card shortcut-card" aria-labelledby="quick-guide-title">
              <h2 id="quick-guide-title">{copy.quickGuide}</h2>
              <div className="shortcut-grid">
                {copy.shortcuts.map(([keys, title, description]) => (
                  <div className="shortcut-item" key={keys}>
                    <kbd>{keys}</kbd>
                    <span><strong>{title}</strong><small>{description}</small></span>
                  </div>
                ))}
              </div>
            </section>

            <details className="companion-card advanced-settings">
              <summary>
                <Settings size={17} aria-hidden="true" />
                <span><strong>{copy.advancedTitle}</strong><small>{copy.advancedBody}</small></span>
                <ChevronRight className="disclosure-chevron" size={17} aria-hidden="true" />
              </summary>
              <div className="preference-list">
                {advancedPreferenceOrder.map((key) => (
                  <SettingRow
                    key={key}
                    title={copy.preferences[key][0]}
                    description={copy.preferences[key][1]}
                    checked={preferences![key]}
                    disabled={controlsDisabled || pendingPreferences.has(key)}
                    onChange={(checked) => void updatePreference(key, checked)}
                  />
                ))}
              </div>
            </details>
          </div>
        ) : null}

        {state.kind === "ready" && activeSection === "privacy" ? (
          <div className="companion-page" id="companion-privacy-page">
            <section className="privacy-hero" aria-labelledby="privacy-title">
              <span className="privacy-hero__icon" aria-hidden="true"><LockKeyhole size={26} /></span>
              <div>
                <div className="trust-badges"><span><WifiOff size={13} />{copy.localOnly}</span><span><ShieldCheck size={13} />{copy.secureFields}</span></div>
                <h2 id="privacy-title">{copy.privacyHeroTitle}</h2>
                <p>{copy.privacyHeroBody}</p>
              </div>
            </section>

            <section className="promise-grid" aria-label={copy.privacyHeroTitle}>
              {copy.privacyPromises.map(([title, description]) => (
                <article key={title}>
                  <CheckCircle2 size={17} aria-hidden="true" />
                  <div><h2>{title}</h2><p>{description}</p></div>
                </article>
              ))}
            </section>

            <section className="companion-card privacy-settings" aria-labelledby="learning-title">
              <div className="privacy-learning-row">
                <div>
                  <h2 id="learning-title">{copy.learningTitle}</h2>
                  <p>{copy.learningBody}</p>
                </div>
                <Switch
                  checked={preferences!.personalizationEnabled}
                  disabled={controlsDisabled || pendingPreferences.has("personalizationEnabled")}
                  label={copy.learningTitle}
                  onChange={(checked) => void updatePreference("personalizationEnabled", checked)}
                />
              </div>
              {isWindowsFallback ? (
                <div className="platform-truth-note platform-truth-note--inside" role="note">
                  <Info size={17} aria-hidden="true" /><p>{copy.exclusionsUnavailable}</p>
                </div>
              ) : (
                <>
                  <div className="excluded-header">
                    <div><h2>{copy.neverLearn}</h2><p>{copy.neverLearnBody}</p></div>
                    <button type="button" className="button button--secondary" disabled={controlsDisabled} onClick={() => void chooseExcludedApplications()}>
                      <Plus size={14} aria-hidden="true" />{copy.addApplications}
                    </button>
                  </div>
                  {excludedApplications.length > 0 ? (
                    <ul className="excluded-list">
                      {excludedApplications.map((identifier) => {
                        const name = applicationNames[identifier] ?? friendlyIdentifier(identifier);
                        return (
                          <li key={identifier}>
                            <span className="application-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
                            <span><strong>{name}</strong><code>{identifier}</code></span>
                            <button
                              type="button"
                              title={copy.removeApplication(name)}
                              aria-label={copy.removeApplication(name)}
                              onClick={() => void saveExcludedApplications(excludedApplications.filter((item) => item !== identifier))}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="excluded-empty"><ShieldCheck size={18} aria-hidden="true" />{copy.noExcludedApps}</div>
                  )}
                  <details className="bundle-identifier-entry">
                    <summary>{copy.advancedBundleTitle}<ChevronRight size={14} aria-hidden="true" /></summary>
                    <form onSubmit={addManualIdentifier}>
                      <label className="sr-only" htmlFor="bundle-identifier">{copy.advancedBundleTitle}</label>
                      <input
                        id="bundle-identifier"
                        type="text"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={manualIdentifier}
                        disabled={controlsDisabled}
                        placeholder={copy.bundleIdentifierPlaceholder}
                        onChange={(event) => setManualIdentifier(event.currentTarget.value)}
                      />
                      <button type="submit" className="button button--secondary" disabled={controlsDisabled || manualIdentifier.trim().length === 0}>{copy.add}</button>
                    </form>
                  </details>
                </>
              )}
            </section>
          </div>
        ) : null}

        {state.kind === "ready" && activeSection === "updates" ? (
          <div className="companion-page" id="companion-updates-page">
            <section className="update-hero" aria-labelledby="updates-title">
              <span className="update-hero__icon" aria-hidden="true"><CloudDownload size={25} /></span>
              <div>
                <h2 id="updates-title">{copy.updateTitle}</h2>
                <p>{updateStatus?.message ?? copy.updateBody}</p>
              </div>
              <div className="update-actions">
                <button type="button" className="button button--primary" disabled={updateBusy} onClick={() => void checkForUpdates()}>
                  {updateBusy ? <span className="button-spinner" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                  {updateBusy ? copy.checking : copy.checkForUpdates}
                </button>
                {updateStatus?.status === "available" ? (
                  <button type="button" className="button button--secondary" disabled={updateBusy} onClick={() => void downloadUpdate()}>
                    {copy.downloadAndVerify}
                  </button>
                ) : null}
              </div>
            </section>

            <section className="update-safety-grid">
              {copy.updateSafety.map(([title, description], index) => (
                <article key={title}><span>{index + 1}</span><div><h2>{title}</h2><p>{description}</p></div></article>
              ))}
            </section>

            <section className="companion-card diagnostics-card" aria-labelledby="diagnostics-title">
              <div className="card-heading">
                <div><h2 id="diagnostics-title">{copy.diagnosticsTitle}</h2><p>{copy.diagnosticsBody}</p></div>
                <Activity size={19} aria-hidden="true" />
              </div>
              <dl className="diagnostic-grid">
                <Metric label={copy.currentVersion} value={window.lekhDesktop?.versions.app ?? "—"} />
                <Metric label={copy.nativeVersion} value={status?.version ?? copy.notInstalled} />
                <Metric label={copy.architecture} value={window.lekhDesktop?.arch ?? "—"} />
                <Metric
                  label={copy.signature}
                  value={<span className={status?.releaseSigned ? "signature-ok" : "signature-development"}>{status?.releaseSigned ? copy.signatureVerified : copy.developmentBuild}</span>}
                />
              </dl>
              <div className="diagnostic-actions">
                <button type="button" className="button button--secondary" onClick={() => void refresh()}><RefreshCw size={14} />{copy.refresh}</button>
                <button type="button" className="button button--secondary" onClick={() => void window.lekhDesktop?.revealInputMethod()}><FolderOpen size={14} />{copy.revealInstallation}</button>
              </div>
            </section>
          </div>
        ) : null}

        {notice ? (
          <div className={`companion-toast companion-toast--${notice.tone}`} role="status" aria-live="polite">
            {notice.tone === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : notice.tone === "error" ? <Info size={15} aria-hidden="true" /> : null}
            {notice.message}
          </div>
        ) : null}
      </main>
    </div>
  );
}
