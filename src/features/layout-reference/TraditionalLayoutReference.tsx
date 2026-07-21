const rows = [
  ["क", "ख", "ग", "घ", "ङ"],
  ["च", "छ", "ज", "झ", "ञ"],
  ["ट", "ठ", "ड", "ढ", "ण"],
  ["त", "थ", "द", "ध", "न"],
  ["प", "फ", "ब", "भ", "म"],
  ["य", "र", "ल", "व", "श"],
  ["ष", "स", "ह", "क्ष", "ज्ञ"]
];

export function TraditionalLayoutReference() {
  return (
    <section className="reference-panel" aria-label="Traditional reference">
      <div className="panel-heading">
        <div>
          <h2>Traditional reference (Beta)</h2>
          <p>This is not a full Traditional key map. It keeps a quick character reference while layout expectations are collected.</p>
        </div>
        <span className="local-badge">Beta</span>
      </div>

      <div className="key-grid" aria-label="Common Devanagari reference keys">
        {rows.flat().map((key) => (
          <span className="keycap" key={key}>
            {key}
          </span>
        ))}
      </div>

      <p className="quiet-note">
        No keydown remapping, native keyboard hook, or installer is included.
      </p>
    </section>
  );
}
