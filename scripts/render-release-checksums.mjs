#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const args = parseArguments(process.argv.slice(2));
const notesPath = resolve(root, requiredArgument("notes"));
const artifactsDirectory = resolve(root, requiredArgument("artifacts"));
const outputPath = resolve(root, requiredArgument("output"));
const checksumsPath = resolve(root, requiredArgument("checksums"));
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const expectedNames = [
  "Lekh-Keyboard-Test-Installer.zip",
  `Lekh-Keyboard-Companion-${packageVersion}-Setup-x64.exe`
];

if (!existsSync(artifactsDirectory)) {
  throw new Error(`Artifact directory does not exist: ${artifactsDirectory}`);
}

const artifactFiles = walkFiles(artifactsDirectory);
const artifacts = [];
for (const expectedName of expectedNames) {
  const matches = artifactFiles.filter((path) => basename(path) === expectedName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${expectedName} in ${artifactsDirectory}; found ${matches.length}.`
    );
  }
  artifacts.push({
    file: expectedName,
    sha256: await sha256(matches[0]),
    bytes: statSync(matches[0]).size
  });
}

const checksumLines = artifacts.map(({ file, sha256: hash }) => `${hash}  ${file}`);
const checksumBlock = [
  "## Artifact checksums",
  "",
  "Generated from the installers built and collected in this same CI run:",
  "",
  "```text",
  ...checksumLines,
  "```",
  ""
].join("\n");
const notes = readFileSync(notesPath, "utf8");
const checksumHeading = "## Artifact checksums";
const checksumHeadingIndex = notes.indexOf(checksumHeading);
if (checksumHeadingIndex < 0 || notes.indexOf(checksumHeading, checksumHeadingIndex + 1) >= 0) {
  throw new Error("Release notes must contain exactly one Artifact checksums heading.");
}

const renderedNotes = `${notes.slice(0, checksumHeadingIndex)}${checksumBlock}`
  .replace(/^# Lekh Assistant v1 Release Notes$/mu, `# Lekh Assistant v${packageVersion} Release Notes`)
  .replaceAll("<version>", packageVersion)
  .replace(
    /Status:[\s\S]*?\n\n## What is included/u,
    `Status: CI-built v${packageVersion} unsigned community preview. The SHA-256 block below was generated from the installers in this release bundle.\n\n## What is included`
  )
  .replace("## Verification completed before E2", "## Verification");

mkdirSync(resolve(outputPath, ".."), { recursive: true });
mkdirSync(resolve(checksumsPath, ".."), { recursive: true });
writeFileSync(outputPath, renderedNotes);
writeFileSync(checksumsPath, `${checksumLines.join("\n")}\n`);

console.log(JSON.stringify({
  status: "passed",
  version: packageVersion,
  releaseNotes: outputPath,
  checksums: checksumsPath,
  artifacts
}, null, 2));

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith("--")) continue;
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex >= 0) {
      parsed.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
      continue;
    }
    parsed.set(argument.slice(2), values[index + 1]);
    index += 1;
  }
  return parsed;
}

function requiredArgument(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing required --${name} argument.`);
  return value;
}

function walkFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) paths.push(...walkFiles(path));
    else paths.push(path);
  }
  return paths;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
