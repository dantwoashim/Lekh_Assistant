import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const root = process.cwd();
const roots = [
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "electron-builder.config.cjs",
  "src",
  "scripts",
  "electron",
  "native/shared",
  "native/daemon/src",
  "native/windows-tsf/skeleton"
];
const checkedExtensions = new Set([".cjs", ".cpp", ".css", ".h", ".json", ".md", ".mjs", ".nsh", ".ps1", ".swift", ".ts", ".tsx"]);
const skipNames = new Set(["node_modules", "dist", ".build", "release", ".tmp"]);
const maxFileBytes = 2 * 1024 * 1024;
const failures = [];

for (const item of roots) {
  walk(join(root, item));
}

if (failures.length > 0) {
  console.error(`Format check failed with ${failures.length} issue(s):`);
  for (const failure of failures.slice(0, 80)) console.error(`- ${failure}`);
  if (failures.length > 80) console.error(`- ... ${failures.length - 80} more`);
  process.exit(1);
}

console.log("Format check passed.");

function walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const name = path.split(/[\\/]/).pop();
    if (skipNames.has(name) || name === "build" || name?.startsWith("build-")) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!checkedExtensions.has(extname(path)) || stat.size > maxFileBytes) return;
  checkFile(path);
}

function checkFile(path) {
  const relative = path.slice(root.length + 1);
  const text = readFileSync(path, "utf8");
  if (text.includes("\r\n")) failures.push(`${relative}: uses CRLF line endings`);
  if (text.length > 0 && !text.endsWith("\n")) failures.push(`${relative}: missing final newline`);
  const lines = text.split(/\n/);
  lines.forEach((line, index) => {
    if (/[ \t]$/.test(line.replace(/\r$/, ""))) {
      failures.push(`${relative}:${index + 1}: trailing whitespace`);
    }
  });
  if (extname(path) === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}
