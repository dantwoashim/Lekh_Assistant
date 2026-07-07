import { Activity, FolderOpen, Keyboard, Languages, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type BooleanPreferenceKey = Exclude<
  keyof LekhNativePreferences,
  "nativeTypingMode" | "excludedApplicationBundleIdentifiers"
>;

type CompanionLocale = "en" | "ne";

type CompanionCopy = {
  localeLabel: string;
  languageName: string;
  unavailableNoBridge: string;
  unavailableReadFailure: string;
  saving: string;
  saved: string;
  savedMode: string;
  saveError: string;
  saveModeError: string;
  excludedSaved: string;
  excludedError: string;
  signedFeedFailed: string;
  updateVerified: (version: string) => string;
  updateArchiveFailed: string;
  productEyebrow: string;
  title: string;
  subtitle: string;
  statusLoading: string;
  statusInstalled: string;
  statusNotInstalled: string;
  versionLine: (status: LekhNativeStatus) => string;
  installHint: string;
  keyboardSettings: string;
  revealInstallation: string;
  refresh: string;
  typingTitle: string;
  typingSubtitle: string;
  defaultMode: string;
  defaultModeHint: string;
  preferences: Record<BooleanPreferenceKey, [string, string]>;
  modes: Record<LekhNativePreferences["nativeTypingMode"], string>;
  neverLearn: string;
  neverLearnHint: string;
  privacyTitle: string;
  privacySubtitle: string;
  privacyBullets: string[];
  fourModesTitle: string;
  fourModesBody: string;
  signedUpdatesTitle: string;
  updateDefault: string;
  checking: string;
  checkForUpdates: string;
  downloadAndVerify: string;
};

const companionCopy: Record<CompanionLocale, CompanionCopy> = {
  en: {
    localeLabel: "Language",
    languageName: "English",
    unavailableNoBridge: "Native controls are available only in the signed Lekh companion app.",
    unavailableReadFailure: "The companion could not read the local input-method status.",
    saving: "Saving…",
    saved: "Saved locally.",
    savedMode: "Saved. The mode applies when Lekh next activates.",
    saveError: "Could not save that setting.",
    saveModeError: "Could not save that mode.",
    excludedSaved: "Excluded-app policy saved locally.",
    excludedError: "Use complete bundle identifiers such as com.example.Editor.",
    signedFeedFailed: "The signed update feed could not be verified.",
    updateVerified: (version) => `Verified Lekh ${version} was revealed in Finder.`,
    updateArchiveFailed: "The update archive failed verification or download.",
    productEyebrow: "Lekh Keyboard",
    title: "Keyboard Companion",
    subtitle: "Configure and inspect the native input method. Typing itself happens inside macOS, not in this window.",
    statusLoading: "Checking keyboard…",
    statusInstalled: "Native keyboard installed",
    statusNotInstalled: "Native keyboard not installed",
    versionLine: (status) =>
      `Version ${status.version ?? "unknown"} · ${status.enabled ? "enabled" : "not enabled"} · ${status.selected ? "currently selected" : "not selected"}`,
    installHint: "Install a verified Lekh input-method package, then enable it in Keyboard Settings.",
    keyboardSettings: "Keyboard Settings",
    revealInstallation: "Reveal installation",
    refresh: "Refresh",
    typingTitle: "Typing",
    typingSubtitle: "These values are written to the native IMK preference domain.",
    defaultMode: "Default native mode",
    defaultModeHint: "Uses the same preference key as the input menu.",
    preferences: {
      inlinePreviewEnabled: ["Inline preview", "Show marked-text composition while typing."],
      customCandidatePanelEnabled: ["Candidate panel", "Show up to eight keyboard candidates."],
      proofreadAsYouTypeEnabled: ["Proofread Traditional input", "Offer local spelling corrections for Devanagari input."],
      smartPunctuationEnabled: ["Nepali punctuation", "Use danda where the active Nepali mode expects it."],
      personalizationEnabled: ["Personal learning", "Learn only explicit candidate choices on this Mac."],
      nextWordPredictionEnabled: ["Contextual ranking", "Use evaluated next-token rows to rerank the active token."]
    },
    modes: {
      "romanized-romanized": "Romanized → Romanized",
      "romanized-traditional": "Romanized → Nepali",
      "traditional-traditional": "Traditional → Nepali",
      "traditional-romanized": "Traditional → Romanized"
    },
    neverLearn: "Never learn in these apps",
    neverLearnHint: "Comma-separated bundle identifiers. Secure fields are always excluded.",
    privacyTitle: "Private by design",
    privacySubtitle: "The native engine runs locally.",
    privacyBullets: [
      "No network or companion IPC is required per keystroke.",
      "Secure fields bypass composition and personalization.",
      "Learning records explicit choices, never raw key logs.",
      "Turning off Personal learning stops new memory writes."
    ],
    fourModesTitle: "Four native modes",
    fourModesBody: "Romanized→Romanized, Romanized→Nepali, Traditional→Nepali, and Traditional→Romanized are selected from the input menu.",
    signedUpdatesTitle: "Signed updates",
    updateDefault: "Checks a pinned HTTPS appcast and verifies SHA-256 plus Ed25519 before revealing an installer.",
    checking: "Checking…",
    checkForUpdates: "Check for Updates",
    downloadAndVerify: "Download and Verify"
  },
  ne: {
    localeLabel: "भाषा",
    languageName: "नेपाली",
    unavailableNoBridge: "नेटिभ नियन्त्रणहरू हस्ताक्षर गरिएको Lekh साथी एपमा मात्र उपलब्ध छन्।",
    unavailableReadFailure: "साथी एपले स्थानीय इनपुट-मेथड स्थिति पढ्न सकेन।",
    saving: "सेभ गर्दै…",
    saved: "स्थानीय रूपमा सेभ भयो।",
    savedMode: "सेभ भयो। Lekh फेरि सक्रिय हुँदा मोड लागू हुन्छ।",
    saveError: "यो सेटिङ सेभ गर्न सकिएन।",
    saveModeError: "यो मोड सेभ गर्न सकिएन।",
    excludedSaved: "बहिष्कृत-एप नीति स्थानीय रूपमा सेभ भयो।",
    excludedError: "com.example.Editor जस्ता पूरा bundle identifier प्रयोग गर्नुहोस्।",
    signedFeedFailed: "हस्ताक्षर गरिएको अपडेट फिड प्रमाणित गर्न सकिएन।",
    updateVerified: (version) => `प्रमाणित Lekh ${version} Finder मा देखाइएको छ।`,
    updateArchiveFailed: "अपडेट archive प्रमाणिकरण वा डाउनलोडमा असफल भयो।",
    productEyebrow: "Lekh Keyboard",
    title: "किबोर्ड साथी",
    subtitle: "नेटिभ input method कन्फिगर र निरीक्षण गर्नुहोस्। टाइपिङ macOS भित्र हुन्छ, यो झ्यालभित्र होइन।",
    statusLoading: "किबोर्ड जाँच गर्दै…",
    statusInstalled: "नेटिभ किबोर्ड इन्स्टल छ",
    statusNotInstalled: "नेटिभ किबोर्ड इन्स्टल छैन",
    versionLine: (status) =>
      `संस्करण ${status.version ?? "अज्ञात"} · ${status.enabled ? "सक्षम" : "अक्षम"} · ${status.selected ? "हाल चयनित" : "चयनित छैन"}`,
    installHint: "प्रमाणित Lekh input-method package इन्स्टल गरेर Keyboard Settings मा सक्षम गर्नुहोस्।",
    keyboardSettings: "Keyboard Settings",
    revealInstallation: "इन्स्टलेशन देखाउनुहोस्",
    refresh: "रिफ्रेस",
    typingTitle: "टाइपिङ",
    typingSubtitle: "यी मानहरू नेटिभ IMK preference domain मा लेखिन्छन्।",
    defaultMode: "पूर्वनिर्धारित नेटिभ मोड",
    defaultModeHint: "इनपुट मेनुसँग एउटै preference key प्रयोग गर्छ।",
    preferences: {
      inlinePreviewEnabled: ["Inline preview", "टाइप गर्दा marked-text composition देखाउनुहोस्।"],
      customCandidatePanelEnabled: ["Candidate panel", "आठवटासम्म किबोर्ड candidate देखाउनुहोस्।"],
      proofreadAsYouTypeEnabled: ["Traditional input proofread", "देवनागरी input का स्थानीय spelling correction देखाउनुहोस्।"],
      smartPunctuationEnabled: ["नेपाली विरामचिह्न", "सक्रिय नेपाली मोडअनुसार डण्डा प्रयोग गर्नुहोस्।"],
      personalizationEnabled: ["व्यक्तिगत सिकाइ", "यस Mac मा explicit candidate choice मात्र सिक्नुहोस्।"],
      nextWordPredictionEnabled: ["Contextual ranking", "सक्रिय token rerank गर्न evaluated next-token rows प्रयोग गर्नुहोस्।"]
    },
    modes: {
      "romanized-romanized": "Romanized → Romanized",
      "romanized-traditional": "Romanized → नेपाली",
      "traditional-traditional": "Traditional → नेपाली",
      "traditional-romanized": "Traditional → Romanized"
    },
    neverLearn: "यी एपहरूमा कहिल्यै नसिक्ने",
    neverLearnHint: "अल्पविरामले छुट्याइएका bundle identifier। Secure fields सधैं बहिष्कृत हुन्छन्।",
    privacyTitle: "गोपनीयतालाई आधार बनाएर",
    privacySubtitle: "नेटिभ engine स्थानीय रूपमा चल्छ।",
    privacyBullets: [
      "प्रत्येक keystroke का लागि network वा companion IPC आवश्यक छैन।",
      "Secure fields ले composition र personalization bypass गर्छ।",
      "Learning ले explicit choice मात्र रेकर्ड गर्छ, raw key log कहिल्यै होइन।",
      "Personal learning बन्द गर्दा नयाँ memory write रोकिन्छ।"
    ],
    fourModesTitle: "चार नेटिभ मोड",
    fourModesBody: "Romanized→Romanized, Romanized→नेपाली, Traditional→नेपाली, र Traditional→Romanized इनपुट मेनुबाट चयन गरिन्छ।",
    signedUpdatesTitle: "हस्ताक्षरित update",
    updateDefault: "Pinned HTTPS appcast जाँचेर installer देखाउनु अघि SHA-256 र Ed25519 प्रमाणित गर्छ।",
    checking: "जाँच गर्दै…",
    checkForUpdates: "Update जाँच्नुहोस्",
    downloadAndVerify: "डाउनलोड र प्रमाणित"
  }
};

function detectCompanionLocale(): CompanionLocale {
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ne")) {
    return "ne";
  }
  return "en";
}

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; status: LekhNativeStatus; preferences: LekhNativePreferences };

export function CompanionShell() {
  const [locale, setLocale] = useState<CompanionLocale>(() => detectCompanionLocale());
  const copy = companionCopy[locale];
  const preferenceLabels = useMemo(
    () => Object.entries(copy.preferences) as Array<[BooleanPreferenceKey, [string, string]]>,
    [copy]
  );
  const modeOptions = useMemo(
    () => Object.entries(copy.modes) as Array<[LekhNativePreferences["nativeTypingMode"], string]>,
    [copy]
  );
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState("");
  const [updateStatus, setUpdateStatus] = useState<LekhUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [excludedDraft, setExcludedDraft] = useState("");

  const refresh = useCallback(async () => {
    const bridge = window.lekhDesktop;
    if (!bridge) {
      setState({
        kind: "unavailable",
        message: companionCopy[detectCompanionLocale()].unavailableNoBridge
      });
      return;
    }
    try {
      const [status, preferences] = await Promise.all([
        bridge.getStatus(),
        bridge.readPreferences()
      ]);
      setState({ kind: "ready", status, preferences });
      setExcludedDraft(preferences.excludedApplicationBundleIdentifiers.join(", "));
    } catch {
      setState({
        kind: "unavailable",
        message: companionCopy[detectCompanionLocale()].unavailableReadFailure
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function updatePreference(key: BooleanPreferenceKey, value: boolean) {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    const previous = state;
    setState({
      ...state,
      preferences: { ...state.preferences, [key]: value }
    });
    setNotice(copy.saving);
    try {
      await window.lekhDesktop.updatePreferences({ [key]: value });
      setNotice(copy.saved);
    } catch {
      setState(previous);
      setNotice(copy.saveError);
    }
  }

  async function updateMode(nativeTypingMode: LekhNativePreferences["nativeTypingMode"]) {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    const previous = state;
    setState({ ...state, preferences: { ...state.preferences, nativeTypingMode } });
    setNotice(copy.saving);
    try {
      await window.lekhDesktop.updatePreferences({ nativeTypingMode });
      setNotice(copy.savedMode);
    } catch {
      setState(previous);
      setNotice(copy.saveModeError);
    }
  }

  async function updateExcludedApplications(value: string) {
    if (state.kind !== "ready" || !window.lekhDesktop) return;
    const identifiers = Array.from(new Set(
      value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)
    ));
    setExcludedDraft(identifiers.join(", "));
    const previous = state;
    setState({
      ...state,
      preferences: {
        ...state.preferences,
        excludedApplicationBundleIdentifiers: identifiers
      }
    });
    setNotice(copy.saving);
    try {
      await window.lekhDesktop.updatePreferences({
        excludedApplicationBundleIdentifiers: identifiers
      });
      setNotice(copy.excludedSaved);
    } catch {
      setState(previous);
      setExcludedDraft(previous.preferences.excludedApplicationBundleIdentifiers.join(", "));
      setNotice(copy.excludedError);
    }
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

  return (
    <main className="companion-shell" lang={locale}>
      <header className="companion-header">
        <div className="companion-mark" aria-hidden="true">ले</div>
        <div className="companion-header-body">
          <p className="eyebrow">{copy.productEyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <label className="locale-selector">
          <Languages size={16} aria-hidden="true" />
          <span>{copy.localeLabel}</span>
          <select value={locale} onChange={(event) => setLocale(event.currentTarget.value as CompanionLocale)}>
            <option value="en">English</option>
            <option value="ne">नेपाली</option>
          </select>
        </label>
      </header>

      <section className="companion-status" aria-labelledby="keyboard-status-title">
        <div>
          <span className={status?.installed ? "status-dot status-dot--ok" : "status-dot"} aria-hidden="true" />
          <div>
            <h2 id="keyboard-status-title">
              {state.kind === "loading"
                ? copy.statusLoading
                : status?.installed
                  ? copy.statusInstalled
                  : copy.statusNotInstalled}
            </h2>
            <p>
              {state.kind === "unavailable"
                ? state.message
                : status?.installed
                  ? copy.versionLine(status)
                  : copy.installHint}
            </p>
          </div>
        </div>
        <div className="companion-actions">
          <button type="button" onClick={() => void window.lekhDesktop?.openKeyboardSettings()}>
            <Settings size={16} aria-hidden="true" />
            {copy.keyboardSettings}
          </button>
          <button type="button" className="secondary" onClick={() => void window.lekhDesktop?.revealInputMethod()}>
            <FolderOpen size={16} aria-hidden="true" />
            {copy.revealInstallation}
          </button>
          <button type="button" className="secondary" onClick={() => void refresh()}>
            <Activity size={16} aria-hidden="true" />
            {copy.refresh}
          </button>
        </div>
      </section>

      <div className="companion-columns">
        <section className="companion-card" aria-labelledby="typing-settings-title">
          <div className="card-title">
            <Keyboard size={19} aria-hidden="true" />
            <div>
              <h2 id="typing-settings-title">{copy.typingTitle}</h2>
              <p>{copy.typingSubtitle}</p>
            </div>
          </div>
          <label className="mode-selector">
            <span>
              <strong>{copy.defaultMode}</strong>
              <small>{copy.defaultModeHint}</small>
            </span>
            <select
              value={state.kind === "ready" ? state.preferences.nativeTypingMode : "romanized-traditional"}
              disabled={state.kind !== "ready" || !status?.installed}
              onChange={(event) => void updateMode(event.currentTarget.value as LekhNativePreferences["nativeTypingMode"])}
            >
              {modeOptions.map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="preference-list">
            {preferenceLabels.map(([key, [label, description]]) => (
              <label className="preference-row" key={key}>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <input
                  type="checkbox"
                  checked={state.kind === "ready" ? state.preferences[key] : false}
                  disabled={state.kind !== "ready" || !status?.installed}
                  onChange={(event) => void updatePreference(key, event.currentTarget.checked)}
                />
              </label>
            ))}
          </div>
          <label className="excluded-apps">
            <span>
              <strong>{copy.neverLearn}</strong>
              <small>{copy.neverLearnHint}</small>
            </span>
            <input
              type="text"
              value={excludedDraft}
              disabled={state.kind !== "ready" || !status?.installed}
              placeholder="com.microsoft.VSCode"
              onChange={(event) => setExcludedDraft(event.currentTarget.value)}
              onBlur={(event) => void updateExcludedApplications(event.currentTarget.value)}
            />
          </label>
          <p className="save-notice" role="status" aria-live="polite">{notice}</p>
        </section>

        <aside className="companion-card privacy-card" aria-labelledby="privacy-title">
          <div className="card-title">
            <ShieldCheck size={19} aria-hidden="true" />
            <div>
              <h2 id="privacy-title">{copy.privacyTitle}</h2>
              <p>{copy.privacySubtitle}</p>
            </div>
          </div>
          <ul>
            {copy.privacyBullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <div className="mode-note">
            <strong>{copy.fourModesTitle}</strong>
            <span>{copy.fourModesBody}</span>
          </div>
          <div className="update-panel">
            <strong>{copy.signedUpdatesTitle}</strong>
            <span>{updateStatus?.message ?? copy.updateDefault}</span>
            <button type="button" disabled={updateBusy} onClick={() => void checkForUpdates()}>
              {updateBusy ? copy.checking : copy.checkForUpdates}
            </button>
            {updateStatus?.status === "available" ? (
              <button type="button" disabled={updateBusy} onClick={() => void downloadUpdate()}>
                {copy.downloadAndVerify}
              </button>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
