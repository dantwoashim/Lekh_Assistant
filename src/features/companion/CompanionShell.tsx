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
import { type ReactNode, useEffect, useLayoutEffect } from "react";

import {
  advancedPreferenceOrder,
  modeOrder,
  type CompanionLocale
} from "./companionCopy";
import { activationPhase, friendlyApplicationIdentifier } from "./companionModel";
import { useCompanionController } from "./useCompanionController";

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
  const {
    activeSection,
    addManualIdentifier,
    applicationNames,
    checkForUpdates,
    chooseExcludedApplications,
    chooseLocale,
    chooseSection,
    copy,
    demoSequence,
    downloadUpdate,
    locale,
    manualIdentifier,
    modePending,
    notice,
    pendingPreferences,
    refresh,
    replayDemo,
    saveExcludedApplications,
    setManualIdentifier,
    state,
    updateBusy,
    updateMode,
    updatePreference,
    updateStatus
  } = useCompanionController();

  useEffect(() => {
    document.title = `${copy.sections[activeSection][0]} — ${copy.productName}`;
  }, [activeSection, copy]);

  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>(".companion-content");
    if (content) content.scrollTop = 0;
  }, [activeSection, state.kind]);

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
                  onClick={replayDemo}
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
                        const name = applicationNames[identifier] ?? friendlyApplicationIdentifier(identifier);
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
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      addManualIdentifier();
                    }}>
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
