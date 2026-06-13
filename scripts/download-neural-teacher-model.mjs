#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const DEFAULT_URL =
  "https://github.com/AI4Bharat/IndicXlit/releases/download/v1.0/indicxlit-en-indic-v1.0.zip";

const MODEL_ID = "ai4bharat-indicxlit-en-indic-v1.0";
const DEFAULT_OUT_DIR = path.resolve(
  "data/generated/neural-teacher-models/ai4bharat-indicxlit/v1.0",
);

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    outDir: DEFAULT_OUT_DIR,
    force: false,
    extract: false,
    allowWordProbDicts: false,
  };

  for (const arg of argv) {
    if (arg === "--force") {
      args.force = true;
    } else if (arg === "--extract") {
      args.extract = true;
    } else if (arg === "--allow-word-prob-dicts") {
      args.allowWordProbDicts = true;
    } else if (arg.startsWith("--url=")) {
      args.url = arg.slice("--url=".length);
    } else if (arg.startsWith("--out-dir=")) {
      args.outDir = path.resolve(arg.slice("--out-dir=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function request(url, onResponse, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.get(parsed, {
      headers: {
        "User-Agent": "LekhKeyboardTeacherModelDownloader/1.0",
      },
    });

    req.on("response", async (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        try {
          resolve(await request(nextUrl, onResponse, redirectsLeft - 1));
        } catch (error) {
          reject(error);
        }
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${status} for ${url}`));
        return;
      }

      try {
        resolve(await onResponse(response));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Timed out while downloading ${url}`));
    });
  });
}

async function download(url, destination) {
  const hash = createHash("sha256");
  const md5 = createHash("md5");
  let received = 0;
  let lastProgressAt = 0;

  const metadata = await request(url, async (response) => {
    const contentLengthHeader = response.headers["content-length"];
    const expectedBytes = contentLengthHeader ? Number(contentLengthHeader) : null;
    const expectedMd5 =
      typeof response.headers["x-ms-blob-content-md5"] === "string"
        ? response.headers["x-ms-blob-content-md5"]
        : null;

    response.on("data", (chunk) => {
      hash.update(chunk);
      md5.update(chunk);
      received += chunk.length;

      const now = Date.now();
      if (now - lastProgressAt > 2000) {
        lastProgressAt = now;
        const receivedMb = (received / 1024 / 1024).toFixed(1);
        if (expectedBytes) {
          const totalMb = (expectedBytes / 1024 / 1024).toFixed(1);
          const percent = ((received / expectedBytes) * 100).toFixed(1);
          process.stdout.write(`Downloading ${receivedMb}/${totalMb} MB (${percent}%)\n`);
        } else {
          process.stdout.write(`Downloading ${receivedMb} MB\n`);
        }
      }
    });

    await pipeline(response, createWriteStream(destination));

    const sha256 = hash.digest("hex");
    const md5Base64 = md5.digest("base64");

    if (expectedBytes !== null && received !== expectedBytes) {
      throw new Error(`Expected ${expectedBytes} bytes but downloaded ${received}`);
    }

    if (expectedMd5 && md5Base64 !== expectedMd5) {
      throw new Error(
        `Downloaded archive MD5 mismatch. Expected ${expectedMd5}; got ${md5Base64}`,
      );
    }

    return {
      bytes: received,
      sha256,
      contentMd5Base64: md5Base64,
      expectedBytes,
      expectedContentMd5Base64: expectedMd5,
      finalContentType:
        typeof response.headers["content-type"] === "string"
          ? response.headers["content-type"]
          : null,
    };
  });

  return metadata;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fileName = path.basename(new URL(args.url).pathname);
  const archivePath = path.join(args.outDir, fileName);
  const partPath = `${archivePath}.part`;
  const extractDir = path.join(args.outDir, "extracted");
  const manifestPath = path.join(args.outDir, "manifest.json");
  const reportPath = path.resolve("reports/neural-teacher-download-report.json");

  if (!args.allowWordProbDicts && /word[_-]?prob/i.test(fileName)) {
    throw new Error(
      "Refusing to download word probability dictionaries by default; they are not needed for the IME teacher model.",
    );
  }

  await mkdir(args.outDir, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });

  let downloadMetadata;
  if (existsSync(archivePath) && !args.force) {
    const existing = await stat(archivePath);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath)) {
      hash.update(chunk);
    }
    downloadMetadata = {
      bytes: existing.size,
      sha256: hash.digest("hex"),
      contentMd5Base64: null,
      expectedBytes: null,
      expectedContentMd5Base64: null,
      finalContentType: null,
      reusedExistingArchive: true,
    };
    process.stdout.write(`Using existing archive: ${archivePath}\n`);
  } else {
    await rm(partPath, { force: true });
    process.stdout.write(`Downloading ${MODEL_ID}\n`);
    process.stdout.write(`Source: ${args.url}\n`);
    process.stdout.write(`Destination: ${archivePath}\n`);
    downloadMetadata = await download(args.url, partPath);
    await rename(partPath, archivePath);
  }

  let extracted = false;
  if (args.extract) {
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await run("unzip", ["-q", archivePath, "-d", extractDir]);
    extracted = true;
  }

  const manifest = {
    id: MODEL_ID,
    role: "teacher-only-not-shipping",
    downloadedAt: new Date().toISOString(),
    source: {
      repository: "https://github.com/AI4Bharat/IndicXlit",
      release: "v1.0",
      asset: fileName,
      url: args.url,
      license: "MIT per upstream repository; release asset does not publish a standalone checksum.",
    },
    archive: {
      path: path.relative(process.cwd(), archivePath),
      ...downloadMetadata,
    },
    extraction: {
      extracted,
      path: extracted ? path.relative(process.cwd(), extractDir) : null,
    },
    productionPolicy: {
      shippingAllowed: false,
      coreML: false,
      approximateParameterCount: 11_000_000,
      reason:
        "Public transformer checkpoint is useful as an offline teacher/regression oracle, but it is not a signed, small Core ML IME hot-path artifact.",
      allowedUse:
        "Offline distillation, benchmarking, and regression tests for the future Lekh Core ML student model.",
      forbiddenUse:
        "Do not copy this archive or extracted checkpoint into models/macos or a released app bundle.",
    },
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`Teacher archive SHA256: ${downloadMetadata.sha256}\n`);
  process.stdout.write(`Manifest: ${manifestPath}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
