import { Keyboard, LayoutGrid, PanelsTopLeft, Settings, ShieldCheck, Type } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { Tabs, type TabItem } from "../components/Tabs";
import type { FeedbackDraft } from "../features/feedback/feedbackReport";

const PreetiConverter = lazy(() => import("../features/preeti/PreetiConverter").then((module) => ({ default: module.PreetiConverter })));
const RomanizedEditor = lazy(() => import("../features/romanized/RomanizedEditor").then((module) => ({ default: module.RomanizedEditor })));
const TraditionalLayoutReference = lazy(() => import("../features/layout-reference/TraditionalLayoutReference").then((module) => ({ default: module.TraditionalLayoutReference })));
const KeyboardLab = lazy(() => import("../features/keyboard/KeyboardLab").then((module) => ({ default: module.KeyboardLab })));
const CompanionShell = lazy(() => import("../features/companion/CompanionShell").then((module) => ({ default: module.CompanionShell })));
const DesktopInterestCta = lazy(() => import("../features/feedback/DesktopInterestCta").then((module) => ({ default: module.DesktopInterestCta })));
const FeedbackPanel = lazy(() => import("../features/feedback/FeedbackPanel").then((module) => ({ default: module.FeedbackPanel })));

type ToolTab = "preeti" | "romanized" | "traditional" | "keyboard" | "companion";

const tabs: TabItem<ToolTab>[] = [
  { id: "keyboard", label: "Keyboard Lab", icon: <PanelsTopLeft size={17} aria-hidden="true" /> },
  { id: "romanized", label: "Romanized", icon: <Keyboard size={17} aria-hidden="true" /> },
  { id: "traditional", label: "Traditional", icon: <LayoutGrid size={17} aria-hidden="true" /> },
  { id: "companion", label: "Companion", icon: <Settings size={17} aria-hidden="true" /> },
  { id: "preeti", label: "Preeti Utility", icon: <Type size={17} aria-hidden="true" /> }
];

export function App() {
  const [activeTab, setActiveTab] = useState<ToolTab>("keyboard");
  const [feedback, setFeedback] = useState<{ tool: FeedbackDraft["tool"]; actual: string }>({
    tool: "preeti",
    actual: ""
  });
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  function openFeedback(tool: FeedbackDraft["tool"], actual: string) {
    setFeedback({ tool, actual });
    setFeedbackOpen(true);
    window.requestAnimationFrame(() => {
      const feedbackPanel = document.getElementById("feedback");
      if (typeof feedbackPanel?.scrollIntoView === "function") {
        feedbackPanel.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Lekh home">
          <img src="/icons/lekh-icon.svg" alt="" />
          <span>Lekh</span>
        </a>
        <div className="privacy-chip">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Local</span>
        </div>
      </header>

      <section className="hero-band">
        <div className="hero-copy">
          <h1>Lekh Keyboard Companion.</h1>
          <p>Native keyboard validation, Romanized typing, local suggestions, and privacy controls.</p>
        </div>
        <div className="hero-panel" aria-label="Workspace summary">
          <span>Windows TSF path</span>
          <span>Romanized → नेपाली</span>
          <span>Companion is not the keyboard</span>
        </div>
      </section>

      <section className="tool-band" aria-label="Typing tools">
        <div className="tool-toolbar">
          <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
          <span className="toolbar-note">No automatic upload</span>
        </div>
        <Suspense fallback={<div className="editor-panel loading-panel">Loading tool…</div>}>
          {activeTab === "preeti" ? <PreetiConverter onReport={openFeedback} /> : null}
          {activeTab === "romanized" ? <RomanizedEditor onReport={openFeedback} /> : null}
          {activeTab === "traditional" ? <TraditionalLayoutReference /> : null}
          {activeTab === "keyboard" ? <KeyboardLab /> : null}
          {activeTab === "companion" ? <CompanionShell /> : null}
        </Suspense>
      </section>

      <Suspense fallback={null}>
        <DesktopInterestCta onInterest={() => openFeedback("desktop-interest", "Interested in a technical desktop preview.")} />
      </Suspense>

      <details
        id="feedback"
        className="feedback-band"
        open={feedbackOpen}
        onToggle={(event) => setFeedbackOpen(event.currentTarget.open)}
      >
        <summary>Feedback</summary>
        <Suspense fallback={<div className="editor-panel loading-panel">Loading feedback…</div>}>
          <FeedbackPanel initialTool={feedback.tool} initialActual={feedback.actual} />
        </Suspense>
      </details>

      <footer className="site-footer">
        <span>Lekh</span>
        <a href="/THIRD_PARTY_NOTICES.txt">Third-party notices</a>
      </footer>
    </main>
  );
}
