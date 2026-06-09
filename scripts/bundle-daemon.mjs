#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import * as esbuild from "esbuild";

const root = process.cwd();
const startedAt = performance.now();
const outfile = join(root, "native", "daemon", "dist", "lekh-keyboard-daemon.mjs");
const reportPath = join(root, "reports", "daemon-bundle-report.json");

try {
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [join(root, "native", "daemon", "src", "daemonCli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    logLevel: "silent",
    banner: {
      js: "#!/usr/bin/env node"
    },
    plugins: [rawQueryPlugin()]
  });

  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run build:daemon",
    suite: "daemon-bundle",
    durationMs: Math.round(performance.now() - startedAt),
    status: "passed",
    artifact: "native/daemon/dist/lekh-keyboard-daemon.mjs"
  };
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: "passed", artifact: report.artifact, report: "reports/daemon-bundle-report.json" }, null, 2));
} catch (error) {
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run build:daemon",
    suite: "daemon-bundle",
    durationMs: Math.round(performance.now() - startedAt),
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  };
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

function rawQueryPlugin() {
  return {
    name: "raw-query-loader",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
        namespace: "raw-file"
      }));
      build.onLoad({ filter: /.*/, namespace: "raw-file" }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))};`,
        loader: "js"
      }));
    }
  };
}
