import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire
} from "@electron/fuses";

export const HARDENED_ELECTRON_FUSES = Object.freeze({
  // The contained daemon deliberately runs through this exact Electron
  // binary in Node mode; the native broker strips hostile environment input
  // and confines it to private inherited handles and a kill-on-close job.
  runAsNode: true,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  // Keep the stock shared Electron snapshot. Enabling the browser-specific
  // fuse without shipping a generated browser_v8_context_snapshot.bin makes
  // the packaged application terminate before main.cjs runs.
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
  wasmTrapHandlers: true
});

const expectedFuseEntries = Object.freeze([
  [FuseV1Options.RunAsNode, FuseState.ENABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
]);

export async function applyHardenedElectronFusePolicy(executable) {
  await flipFuses(executable, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: HARDENED_ELECTRON_FUSES.runAsNode,
    [FuseV1Options.EnableCookieEncryption]: HARDENED_ELECTRON_FUSES.enableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
      HARDENED_ELECTRON_FUSES.enableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]:
      HARDENED_ELECTRON_FUSES.enableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
      HARDENED_ELECTRON_FUSES.enableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: HARDENED_ELECTRON_FUSES.onlyLoadAppFromAsar,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]:
      HARDENED_ELECTRON_FUSES.loadBrowserProcessSpecificV8Snapshot,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]:
      HARDENED_ELECTRON_FUSES.grantFileProtocolExtraPrivileges,
    [FuseV1Options.WasmTrapHandlers]: HARDENED_ELECTRON_FUSES.wasmTrapHandlers
  });
}

export async function verifyHardenedElectronFusePolicy(executable) {
  const fuseWire = await getCurrentFuseWire(executable);
  const fuseMismatches = expectedFuseEntries.flatMap(([option, expected]) => {
    const actual = fuseWire?.[option];
    return actual === expected ? [] : [{ name: FuseV1Options[option], expected, actual }];
  });
  const wireFuseCount = Object.keys(fuseWire ?? {}).filter((key) => /^\d+$/.test(key)).length;
  return {
    valid:
      fuseWire?.version === FuseVersion.V1 &&
      wireFuseCount === expectedFuseEntries.length &&
      fuseMismatches.length === 0,
    version: fuseWire?.version ?? null,
    wireFuseCount,
    expectedFuseCount: expectedFuseEntries.length,
    fuseMismatches
  };
}
