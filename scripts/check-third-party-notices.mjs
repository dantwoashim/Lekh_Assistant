#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const noticePath = join(root, "public", "THIRD_PARTY_NOTICES.txt");
const notices = readFileSync(noticePath, "utf8").toLowerCase();

const requiredPackages = [
  "@nepalibhasha/converter",
  "dictionary-ne",
  "electron",
  "electron-builder",
  "lucide-react",
  "nspell",
  "react",
  "react-dom",
  "saxes",
  "vite",
];

const missing = requiredPackages.filter((name) => !notices.includes(name.toLowerCase()));

if (missing.length > 0) {
  console.error(JSON.stringify({
    status: "failed",
    noticePath: "public/THIRD_PARTY_NOTICES.txt",
    missing,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "passed",
  noticePath: "public/THIRD_PARTY_NOTICES.txt",
  checked: requiredPackages.length,
}, null, 2));
