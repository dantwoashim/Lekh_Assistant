import { Activity, BookOpen, Database, EyeOff, Keyboard, ListChecks, Settings, ShieldCheck, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { companionPages, defaultCompanionSettings } from "./settings";

const statusRows = [
  ["Keyboard engine", "Native-ready API and lab validation pass"],
  ["Per-user daemon", "JSONL IPC process available for native shells"],
  ["Native Windows", "TSF DLL source and installer registration path ready for Windows build validation"],
  ["Native macOS", "Swift IMK/XPC proof build available; installed validation still needs Xcode/signing"],
  ["Traditional layout", "Physical keymap blocked on LTK audit"],
  ["Privacy", "No typed-text upload, no hidden telemetry"]
] as const;

const diagnostics = [
  "Daemon health: available through native IPC health.check",
  "IPC latency: recorded in response latencyMs",
  "Benchmark reports: bench/reports/*.json",
  "Diagnostics export: redacted by policy"
] as const;

export function CompanionShell() {
  const privacyPage = companionPages.find((page) => page.id === "privacy");

  return (
    <section className="companion-layout" aria-label="Companion app console">
      <div className="editor-panel companion-hero-panel">
        <div className="panel-heading">
          <div>
            <h2>Companion App Console</h2>
            <p>Settings, privacy, dictionary, memory, diagnostics, install status, and Preeti side utility for the native keyboard stack. This app is not the IME.</p>
          </div>
          <span className="local-badge">Companion</span>
        </div>

        <div className="companion-status-grid">
          {statusRows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="companion-grid">
        <CompanionCard
          icon={<Keyboard size={17} aria-hidden="true" />}
          title="Typing Settings"
          rows={[
            `Default mode: ${defaultCompanionSettings.defaultMode}`,
            `Romanized helpers: ${defaultCompanionSettings.enableRomanizedHelpers ? "on" : "off"}`,
            `Romanized labels: ${defaultCompanionSettings.showRomanizedLabels ? "on" : "off"}`,
            `Candidate count: ${defaultCompanionSettings.candidateCount}`,
            `Space behavior: ${defaultCompanionSettings.spaceCommitBehavior}`,
            "Traditional physical layout waits for verified audit data"
          ]}
        />
        <CompanionCard
          icon={<BookOpen size={17} aria-hidden="true" />}
          title="Dictionary Manager"
          rows={[
            "Offline lookup for canonical spelling and aliases",
            "Meanings remain unavailable until a safe licensed source exists",
            "Personal word add/prefer/never-suggest controls are available in the settings model"
          ]}
        />
        <CompanionCard
          icon={<Database size={17} aria-hidden="true" />}
          title="Personal Memory"
          rows={[
            "Local correction memory can boost accepted candidates",
            "Pinned entries can win when safe",
            "Never-suggest blocks known unwanted spellings",
            "Export/import/reset are local storage operations",
            `Learning paused: ${defaultCompanionSettings.pauseLearning ? "yes" : "no"}`,
            `Excluded apps: ${defaultCompanionSettings.excludedMemoryApps.length}`,
            "Secure input disables memory writes"
          ]}
        />
        <CompanionCard
          icon={<ShieldCheck size={17} aria-hidden="true" />}
          title="Privacy Page"
          rows={[
            "Privacy page is present in the companion navigation",
            "No global key hook in the companion",
            "No foreground-text reading",
            "No network for normal typing",
            `Telemetry: ${defaultCompanionSettings.telemetryEnabled ? "on" : "off"}`,
            "Redacted diagnostics export only",
            "Export/import/reset controls remain local",
            "Consented examples only for pilot data"
          ]}
        />
        <CompanionCard
          icon={<Activity size={17} aria-hidden="true" />}
          title="Diagnostics"
          rows={diagnostics}
        />
        <CompanionCard
          icon={<Wrench size={17} aria-hidden="true" />}
          title="Document Tools"
          rows={[
            "Preeti converter remains a side utility",
            "Advanced mixed-document repair stays deferred",
            "Keyboard features remain the core product"
          ]}
        />
      </div>

      <aside className="side-panel companion-page-list" aria-label="Companion pages">
        <div className="side-panel__heading">
          <ListChecks size={17} aria-hidden="true" />
          <h3>Production Pages</h3>
        </div>
        <div className="companion-page-grid">
          {companionPages.map((page) => (
            <span key={page.id} data-status={page.status}>
              {page.title}
              <small>{page.status}</small>
            </span>
          ))}
        </div>
        <div className="companion-checklist" aria-label="Companion controls">
          {companionPages.slice(0, 6).map((page) => (
            <div key={page.id}>
              <strong>{page.title}</strong>
              <p>{page.controls.join(", ")}</p>
            </div>
          ))}
        </div>
        <div className="companion-privacy-panel" aria-label="Privacy page readiness">
          <div>
            <ShieldCheck size={17} aria-hidden="true" />
            <h3>Privacy Page Ready</h3>
          </div>
          <p>
            The companion privacy page exposes local-first typing, secure input pass-through, telemetry-off defaults,
            consent controls, redacted diagnostics, and local data deletion.
          </p>
          <ul>
            {(privacyPage?.controls ?? []).map((control) => (
              <li key={control}>{control}</li>
            ))}
          </ul>
        </div>
        <p className="quiet-note">
          <EyeOff size={14} aria-hidden="true" />
          Companion app controls settings and diagnostics; native TSF/IMK remains the production keystroke path.
        </p>
        <p className="quiet-note">
          <Settings size={14} aria-hidden="true" />
          Release channel: {defaultCompanionSettings.releaseChannel}; signed public updates remain blocked until platform signing is available.
        </p>
      </aside>
    </section>
  );
}

interface CompanionCardProps {
  icon: ReactNode;
  title: string;
  rows: readonly string[];
}

function CompanionCard({ icon, title, rows }: CompanionCardProps) {
  return (
    <article className="companion-card">
      <div>
        {icon}
        <h3>{title}</h3>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </article>
  );
}
