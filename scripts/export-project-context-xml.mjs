import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(ROOT, "release", "audit", "Lekh-Complete-Project-Context.xml");
const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const temporaryOutputPath = `${outputPath}.tmp`;
const fullTextLimitBytes = 512 * 1024;
const sampleBytesPerEdge = 24 * 1024;

const promptFiles = [
  "docs/agent-prompts/LEKH_FORENSIC_AUDIT_PROMPT.md",
  "docs/agent-prompts/LEKH_LEVEL5_IMPLEMENTATION_PROMPT.md"
];

const binaryExtensions = new Set([
  ".bin",
  ".icns",
  ".ico",
  ".lkb",
  ".png",
  ".weights",
  ".zip"
]);

const sourceExtensions = new Set([
  ".c",
  ".cjs",
  ".cpp",
  ".css",
  ".h",
  ".html",
  ".js",
  ".mjs",
  ".nsh",
  ".plist",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml"
]);

const latestFindings = [
  {
    id: "F001",
    status: "confirmed",
    text: "The macOS IMK defaults to the in-process LekhStaticProofEngineClient. LekhXpcClient.swift contains no NSXPCConnection and is misnamed."
  },
  {
    id: "F002",
    status: "confirmed",
    text: "The TypeScript engine and native Swift engine remain separate implementations. Complexity alone does not prove the TypeScript engine is better; both require the same human-gold evaluation before porting."
  },
  {
    id: "F003",
    status: "confirmed",
    text: "The packaged Core ML artifact is a non-production closed-vocabulary linear-softmax baseline. Its manifest reports fullGeneratedSplitTop1Accuracy 0.085231 and productionEligible false."
  },
  {
    id: "F004",
    status: "confirmed",
    text: "The current native controller handles Space before the engine while inline composition is active: explicit candidate selection commits the candidate; otherwise it commits the raw Latin buffer. The engine also has a duplicate raw-Space branch, but this is duplicate authority rather than a demonstrated race."
  },
  {
    id: "F005",
    status: "design-decision-required",
    text: "The final Space contract is unresolved. A Level-5 plan must explicitly distinguish deterministic transliteration, ranked prediction, and literal raw Latin. It must provide an ergonomic preserve-raw gesture and must not force Tab for every Nepali word."
  },
  {
    id: "F006",
    status: "confirmed",
    text: "Single-token composition currently filters multi-word candidates, reducing the earlier phrase-expansion failure. A 13-row hardcoded phrase table still exists and should not be mistaken for the entire phrase system because runtime packs also contain phrase rows."
  },
  {
    id: "F007",
    status: "confirmed",
    text: "Inline grey preview is implemented with attributed IMK marked text containing raw input plus a candidate. InputMethodKit has no universal trailing-ghost API; host applications may override marked-text colours and styles."
  },
  {
    id: "F008",
    status: "confirmed",
    text: "The custom candidate panel now has clickable AppKit rows, highlighted selection, controller-driven arrow navigation, and numeric shortcuts. It still requires accessibility, duplicate-commit, focus, positioning, and cross-host evidence."
  },
  {
    id: "F009",
    status: "confirmed",
    text: "lekhHotPathBudgetMilliseconds is passed into processKey but is not enforced by the engine. Changing 50 to 5 does not create a deadline; bounded algorithms and benchmark release gates are required."
  },
  {
    id: "F010",
    status: "confirmed",
    text: "Session buffers in LekhStaticProofEngineClient are mutable dictionaries without a dedicated synchronization boundary. Binary lexicon validateEntries, validatePrefixes, and validateRefs are defined but not called."
  },
  {
    id: "F011",
    status: "confirmed",
    text: "Romanized-to-Nepali is the only comparatively complete native mode. Romanized-to-Romanized and both Traditional modes need explicit product definitions, complete pipelines, and human validation."
  },
  {
    id: "F012",
    status: "confirmed",
    text: "The current release artifact is ad-hoc signed. Developer ID signing, hardened-runtime verification, notarization, stapling, clean installation, rollback, and uninstall remain production gates."
  },
  {
    id: "F013",
    status: "confirmed",
    text: "Real host-app behavior is not proven across the full matrix. App-specific workarounds must follow reproduced evidence; IMK code cannot reliably infer a Chrome tab URL or Google Docs context without invasive external permissions."
  },
  {
    id: "F014",
    status: "architecture",
    text: "The preferred target is an in-process pure-Swift LekhEngineCore for deterministic typing, with no synchronous XPC or network dependency on the keystroke path. Administrative IPC may be used for settings, signed pack management, or diagnostics."
  },
  {
    id: "F015",
    status: "architecture",
    text: "A canonical transliteration specification should generate deterministic Swift and TypeScript tables. Exact parity is required for deterministic stages; contextual ranking should use metric and tolerance-based parity rather than fragile floating-point identity."
  }
];

function runGit(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}

function trackedAndUntrackedPaths() {
  const raw = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }
  );
  const outputRelative = relative(ROOT, outputPath);
  const temporaryRelative = relative(ROOT, temporaryOutputPath);
  return raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== outputRelative && path !== temporaryRelative)
    .filter((path) => !path.startsWith(".git/"))
    .sort((left, right) => left.localeCompare(right));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function xmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizeXmlText(value) {
  return value.replace(
    // XML 1.0 permits tab, LF, CR, and characters from U+0020 upward.
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,
    "\uFFFD"
  );
}

function cdata(value) {
  return `<![CDATA[${sanitizeXmlText(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function isUtf8Text(buffer, extension) {
  if (binaryExtensions.has(extension)) return false;
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function categoryFor(path) {
  if (path.startsWith("native/macos-imk/")) return "macos-imk";
  if (path.startsWith("native/")) return "native-other";
  if (path.startsWith("src/engine/") || path.startsWith("src/core/")) return "engine";
  if (path.startsWith("src/")) return "application";
  if (path.startsWith("scripts/")) return "build-tooling";
  if (path.startsWith("models/")) return "model";
  if (path.startsWith("data/") || path.startsWith("bench/") || path.startsWith("benchmarks/")) return "data-evaluation";
  if (path.startsWith("release/") || path.startsWith("public/updates/")) return "release-artifact";
  if (path.startsWith("docs/") || path.endsWith(".md")) return "documentation";
  return "project";
}

function mediaTypeFor(extension, text) {
  if (text) {
    if (extension === ".json") return "application/json";
    if (extension === ".xml" || extension === ".plist") return "application/xml";
    if (extension === ".html") return "text/html";
    if (extension === ".css") return "text/css";
    return "text/plain";
  }
  if (extension === ".zip") return "application/zip";
  if (extension === ".png") return "image/png";
  if (extension === ".icns" || extension === ".ico") return "image/icon";
  return "application/octet-stream";
}

function datasetSummary(path, buffer, extension) {
  if (extension === ".json") {
    try {
      const object = JSON.parse(buffer.toString("utf8"));
      if (Array.isArray(object)) {
        return { shape: "array", entries: object.length };
      }
      if (object && typeof object === "object") {
        const keys = Object.keys(object);
        const collections = {};
        for (const key of keys) {
          const value = object[key];
          if (Array.isArray(value)) collections[key] = value.length;
          else if (value && typeof value === "object") collections[key] = Object.keys(value).length;
        }
        return { shape: "object", keys, collections };
      }
    } catch {
      return { shape: "invalid-or-streamed-json" };
    }
  }
  if (extension === ".jsonl" || extension === ".tsv" || extension === ".txt") {
    let lines = 0;
    for (const byte of buffer) {
      if (byte === 10) lines += 1;
    }
    return { shape: extension.slice(1), lines };
  }
  return { shape: "large-text", path };
}

function sampledText(buffer) {
  const head = buffer.subarray(0, sampleBytesPerEdge).toString("utf8");
  const tail = buffer.subarray(Math.max(0, buffer.length - sampleBytesPerEdge)).toString("utf8");
  return {
    head,
    tail,
    omittedBytes: Math.max(0, buffer.length - (sampleBytesPerEdge * 2))
  };
}

function promptElement(path, index) {
  const absolutePath = join(ROOT, path);
  if (!existsSync(absolutePath)) {
    return `    <prompt index="${index + 1}" path="${xmlAttribute(path)}" missing="true"/>`;
  }
  return [
    `    <prompt index="${index + 1}" path="${xmlAttribute(path)}">`,
    `      <content>${cdata(readFileSync(absolutePath, "utf8"))}</content>`,
    "    </prompt>"
  ].join("\n");
}

function findingElement(finding) {
  return `    <finding id="${xmlAttribute(finding.id)}" status="${xmlAttribute(finding.status)}">${cdata(finding.text)}</finding>`;
}

function fileElement(path) {
  const absolutePath = join(ROOT, path);
  const stats = statSync(absolutePath);
  const buffer = readFileSync(absolutePath);
  const extension = extname(path).toLowerCase();
  const text = isUtf8Text(buffer, extension);
  const category = categoryFor(path);
  const mediaType = mediaTypeFor(extension, text);
  const sourcePriority = sourceExtensions.has(extension) || category === "macos-imk" || category === "engine";
  const fullText = text && (buffer.length <= fullTextLimitBytes || (sourcePriority && buffer.length <= 2 * 1024 * 1024));
  const inclusion = !text ? "metadata" : fullText ? "full" : "sampled";
  const lines = [
    `    <file path="${xmlAttribute(path)}" category="${xmlAttribute(category)}" mediaType="${xmlAttribute(mediaType)}" bytes="${stats.size}" sha256="${sha256(buffer)}" inclusion="${inclusion}">`
  ];

  if (fullText) {
    lines.push(`      <content encoding="utf-8">${cdata(buffer.toString("utf8"))}</content>`);
  } else if (text) {
    const sample = sampledText(buffer);
    lines.push(`      <summary format="json">${cdata(JSON.stringify(datasetSummary(path, buffer, extension)))}</summary>`);
    lines.push(`      <sample omittedBytes="${sample.omittedBytes}">`);
    lines.push(`        <head>${cdata(sample.head)}</head>`);
    lines.push(`        <tail>${cdata(sample.tail)}</tail>`);
    lines.push("      </sample>");
  } else {
    lines.push("      <contentOmitted reason=\"binary-or-non-UTF8\"/>");
  }

  lines.push("    </file>");
  return { xml: lines.join("\n"), inclusion, bytes: stats.size };
}

const paths = trackedAndUntrackedPaths();
const fileElements = [];
const counts = { full: 0, sampled: 0, metadata: 0 };
let totalBytes = 0;

for (const path of paths) {
  const result = fileElement(path);
  fileElements.push(result.xml);
  counts[result.inclusion] += 1;
  totalBytes += result.bytes;
}

const commit = runGit(["rev-parse", "HEAD"]);
const branch = runGit(["branch", "--show-current"]);
const status = runGit(["status", "--short"]);
const remote = runGit(["remote", "get-url", "origin"]);
const generatedAt = new Date().toISOString();

const xml = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<lekhProjectContext schemaVersion=\"1.0\">",
  "  <metadata>",
  `    <projectName>Lekh Keyboard</projectName>`,
  `    <repositoryRemote>${cdata(remote)}</repositoryRemote>`,
  `    <branch>${cdata(branch)}</branch>`,
  `    <commit>${cdata(commit)}</commit>`,
  `    <generatedAt>${cdata(generatedAt)}</generatedAt>`,
  `    <workingTreeStatus clean="${status.length === 0 ? "true" : "false"}">${cdata(status)}</workingTreeStatus>`,
  `    <inventory files="${paths.length}" sourceBytes="${totalBytes}" fullTextFiles="${counts.full}" sampledTextFiles="${counts.sampled}" metadataOnlyFiles="${counts.metadata}"/>`,
  "  </metadata>",
  "  <usage>",
  "    <instruction>This XML is the authoritative project-audit context. Inspect embedded source before making claims. Sampled datasets and metadata-only binaries remain represented by path, size, SHA-256, and summaries. Request a specific original file only when the sampled representation is insufficient.</instruction>",
  "    <instruction>Do not infer production readiness from generated reports or README claims. Separate confirmed code evidence, runtime inference, and unknowns requiring a real macOS host test.</instruction>",
  "    <instruction>Do not propose a browser, Electron shell, companion app, accessibility overlay, or event tap as the system keyboard. The keyboard is the InputMethodKit bundle.</instruction>",
  "  </usage>",
  "  <latestValidatedFindings>",
  ...latestFindings.map(findingElement),
  "  </latestValidatedFindings>",
  "  <agentPrompts>",
  ...promptFiles.map(promptElement),
  "  </agentPrompts>",
  "  <repositoryPathInventory>",
  `    ${cdata(paths.join("\n"))}`,
  "  </repositoryPathInventory>",
  "  <files>",
  ...fileElements,
  "  </files>",
  "</lekhProjectContext>",
  ""
].join("\n");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(temporaryOutputPath, xml, "utf8");
renameSync(temporaryOutputPath, outputPath);

const finalStats = statSync(outputPath);
console.log(JSON.stringify({
  status: "passed",
  output: relative(ROOT, outputPath),
  bytes: finalStats.size,
  sourceFiles: paths.length,
  sourceBytes: totalBytes,
  fullTextFiles: counts.full,
  sampledTextFiles: counts.sampled,
  metadataOnlyFiles: counts.metadata,
  commit
}, null, 2));
