import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type FetchOptions = {
  fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<MockResponse>;
  headers?: Record<string, string>;
  maximumRedirects?: number;
  timeoutMs?: number;
  validateUrl?: (url: string) => void;
};

type MockResponse = {
  body: MockBody;
  headers: Headers;
  ok: boolean;
  status: number;
  url: string;
};

type MockBody = {
  locked: boolean;
  cancel: ReturnType<typeof vi.fn>;
  getReader: ReturnType<typeof vi.fn>;
};

type UpdateSecurityModule = {
  APPCAST_ERROR: string;
  RESPONSE_SIZE_ERROR: string;
  SPARKLE_NAMESPACE: string;
  fetchBounded: (url: string, maximumBytes: number, options?: FetchOptions) => Promise<Buffer>;
  parseAppcast: (input: string | Uint8Array) => {
    url: string;
    version: string;
    shortVersion: string;
    minimumAutoupdateVersion: string;
    length: number;
    type: string;
    sha256: string;
    signature: string;
  };
  validatePinnedHttpsUrl: (url: string, expectedHost: string) => string;
};

const require = createRequire(import.meta.url);
const updateSecurity = require("../electron/update-security.cjs") as UpdateSecurityModule;
const pinnedHost = "lekh-assistant.pages.dev";
const pinnedUrl = `https://${pinnedHost}/updates/macos/appcast.xml`;
const signature = Buffer.alloc(64, 0x5a).toString("base64");
const sha256 = "a".repeat(64);

describe("bounded Electron update responses", () => {
  it("requires an explicit URL trust policy before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(updateSecurity.fetchBounded(pinnedUrl, 32, { fetchImpl })).rejects.toThrow(
      "URL validator"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams a response with no Content-Length up to the exact byte limit", async () => {
    const response = mockResponse({ chunks: ["le", "kh", "!"] });
    const fetchImpl = vi.fn(async () => response.value);

    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 5, {
        fetchImpl,
        validateUrl: validatePinnedUrl
      })
    ).resolves.toEqual(Buffer.from("lekh!"));
    expect(response.reader.read).toHaveBeenCalledTimes(4);
    expect(response.reader.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["misleading", "1"]
  ])("aborts an oversize chunked response with %s Content-Length", async (_label, length) => {
    const response = mockResponse({
      chunks: ["1234", "5678", "must-not-be-read"],
      contentLength: length
    });
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      requestSignal = init.signal;
      return response.value;
    });

    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 6, {
        fetchImpl,
        validateUrl: validatePinnedUrl
      })
    ).rejects.toThrow(updateSecurity.RESPONSE_SIZE_ERROR);
    expect(response.reader.read).toHaveBeenCalledTimes(2);
    expect(response.reader.cancel).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects an oversized declared length before opening the response reader", async () => {
    const response = mockResponse({ chunks: ["small"], contentLength: "999" });

    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 8, {
        fetchImpl: vi.fn(async () => response.value),
        validateUrl: validatePinnedUrl
      })
    ).rejects.toThrow(updateSecurity.RESPONSE_SIZE_ERROR);
    expect(response.body.getReader).not.toHaveBeenCalled();
    expect(response.body.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["-1", "1e3", "10, 10", "9007199254740992"])(
    "fails closed on invalid Content-Length %s",
    async (contentLength) => {
      const response = mockResponse({ chunks: ["small"], contentLength });
      await expect(
        updateSecurity.fetchBounded(pinnedUrl, 16, {
          fetchImpl: vi.fn(async () => response.value),
          validateUrl: validatePinnedUrl
        })
      ).rejects.toThrow("invalid Content-Length");
      expect(response.body.getReader).not.toHaveBeenCalled();
    }
  );

  it("refuses an unpinned redirect before issuing the redirected request", async () => {
    const redirect = mockResponse({
      chunks: [],
      status: 302,
      location: "https://updates.example.invalid/payload.zip"
    });
    const fetchImpl = vi.fn(async () => redirect.value);

    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 32, { fetchImpl, validateUrl: validatePinnedUrl })
    ).rejects.toThrow("pinned HTTPS host");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(redirect.body.cancel).toHaveBeenCalledTimes(1);
  });

  it("follows a same-host redirect manually and applies the stream bound to the final body", async () => {
    const redirect = mockResponse({
      chunks: [],
      status: 307,
      location: "/updates/macos/current.xml"
    });
    const finalResponse = mockResponse({
      chunks: ["valid"],
      contentLength: "5",
      url: `https://${pinnedHost}/updates/macos/current.xml`
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect.value)
      .mockResolvedValueOnce(finalResponse.value);

    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 5, { fetchImpl, validateUrl: validatePinnedUrl })
    ).resolves.toEqual(Buffer.from("valid"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `https://${pinnedHost}/updates/macos/current.xml`
    );
    expect(redirect.body.cancel).toHaveBeenCalledTimes(1);
  });

  it("validates the URL reported by the final response", async () => {
    const response = mockResponse({
      chunks: ["payload"],
      url: "https://cdn.example.invalid/payload.zip"
    });
    await expect(
      updateSecurity.fetchBounded(pinnedUrl, 32, {
        fetchImpl: vi.fn(async () => response.value),
        validateUrl: validatePinnedUrl
      })
    ).rejects.toThrow("pinned HTTPS host");
    expect(response.body.getReader).not.toHaveBeenCalled();
  });

  it.each([
    `http://${pinnedHost}/payload.zip`,
    `https://subdomain.${pinnedHost}/payload.zip`,
    `https://user@${pinnedHost}/payload.zip`,
    `https://${pinnedHost}:444/payload.zip`,
    `https://${pinnedHost}/payload.zip#fragment`,
    ` https://${pinnedHost}/payload.zip`
  ])("rejects a non-canonical pinned update URL %s", (url) => {
    expect(() => updateSecurity.validatePinnedHttpsUrl(url, pinnedHost)).toThrow(
      "pinned HTTPS host"
    );
  });
});

describe("strict Electron appcast parsing", () => {
  it("parses the single canonical item by namespace URI, independent of prefix", () => {
    const xml = canonicalAppcast({ prefix: "release" });
    expect(updateSecurity.parseAppcast(xml)).toEqual({
      url: `https://${pinnedHost}/updates/macos/Lekh.zip`,
      version: "176",
      shortVersion: "0.1.0",
      minimumAutoupdateVersion: "176",
      length: 5,
      type: "application/zip",
      sha256,
      signature
    });
  });

  it("decodes built-in XML entities without accepting custom entity declarations", () => {
    const xml = canonicalAppcast({
      url: `https://${pinnedHost}/updates/macos/Lekh.zip?channel=stable&amp;cohort=qa`
    });
    expect(updateSecurity.parseAppcast(xml).url).toBe(
      `https://${pinnedHost}/updates/macos/Lekh.zip?channel=stable&cohort=qa`
    );

    expect(() => updateSecurity.parseAppcast(xml.replace("stable&amp;", "stable&unknown;"))).toThrow(
      updateSecurity.APPCAST_ERROR
    );
    expect(() =>
      updateSecurity.parseAppcast(
        xml.replace(
          "<rss ",
          '<!DOCTYPE rss [<!ENTITY payload SYSTEM "file:///etc/passwd">]>\n<rss '
        )
      )
    ).toThrow(updateSecurity.APPCAST_ERROR);
  });

  it.each([
    ["unclosed XML", (xml: string) => xml.replace("</rss>", "")],
    [
      "duplicate version element",
      (xml: string) => xml.replace(
        "</sparkle:version>",
        "</sparkle:version><sparkle:version>176</sparkle:version>"
      )
    ],
    [
      "duplicate rollback floor",
      (xml: string) => xml.replace(
        "</sparkle:minimumAutoupdateVersion>",
        "</sparkle:minimumAutoupdateVersion><sparkle:minimumAutoupdateVersion>176</sparkle:minimumAutoupdateVersion>"
      )
    ],
    [
      "duplicate enclosure",
      (xml: string) => xml.replace("</item>", `${enclosure()}\n</item>`)
    ],
    [
      "multiple items",
      (xml: string) => xml.replace("</channel>", `${item()}\n</channel>`)
    ],
    [
      "namespace-spoofed version",
      (xml: string) => xml.replace(
        "<sparkle:version>176</sparkle:version>",
        '<spoof:version xmlns:spoof="urn:spoof">176</spoof:version>'
      )
    ],
    [
      "duplicate URL attribute",
      (xml: string) => xml.replace(
        `url="https://${pinnedHost}/updates/macos/Lekh.zip"`,
        `url="https://${pinnedHost}/updates/macos/Lekh.zip" url="https://${pinnedHost}/other.zip"`
      )
    ],
    ["non-canonical enclosure length", (xml: string) => xml.replace('length="5"', 'length="5e0"')],
    [
      "non-ZIP enclosure type",
      (xml: string) => xml.replace('type="application/zip"', 'type="application/octet-stream"')
    ],
    [
      "rollback floor above the release build",
      (xml: string) => xml.replace(
        "<sparkle:minimumAutoupdateVersion>176</sparkle:minimumAutoupdateVersion>",
        "<sparkle:minimumAutoupdateVersion>177</sparkle:minimumAutoupdateVersion>"
      )
    ]
  ])("rejects %s", (_label, mutate) => {
    expect(() => updateSecurity.parseAppcast(mutate(canonicalAppcast()))).toThrow(
      updateSecurity.APPCAST_ERROR
    );
  });

  it.each([
    ["build", { versionAttribute: "177" }],
    ["short version", { shortVersionAttribute: "0.1.1" }]
  ])("rejects ambiguous %s metadata", (_label, overrides) => {
    expect(() => updateSecurity.parseAppcast(canonicalAppcast(overrides))).toThrow(
      updateSecurity.APPCAST_ERROR
    );
  });

  it("rejects non-UTF-8 appcast bytes and non-canonical Ed25519 signatures", () => {
    expect(() => updateSecurity.parseAppcast(Uint8Array.from([0xc3, 0x28]))).toThrow(
      updateSecurity.APPCAST_ERROR
    );
    expect(() => updateSecurity.parseAppcast(canonicalAppcast({ signature: "YQ==" }))).toThrow(
      updateSecurity.APPCAST_ERROR
    );
  });
});

describe("Electron update source integration", () => {
  it("keeps the production trust anchors and delegates parsing and bounded reads", () => {
    const root = process.cwd();
    const main = readFileSync(join(root, "electron", "main.cjs"), "utf8");
    const security = readFileSync(join(root, "electron", "update-security.cjs"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(main).toContain('require("./update-security.cjs")');
    expect(main.match(/fetchBounded\(/g)).toHaveLength(2);
    expect(main).toContain("const details = parseAppcast(xml);");
    expect(main).toContain('const updateFeedUrl = "https://lekh-assistant.pages.dev/');
    expect(main).toContain('const updateHost = "lekh-assistant.pages.dev";');
    expect(main).toContain("updatePublicKeyBase64");
    expect(main).toContain('createHash("sha256")');
    expect(main).toContain("verifySignature(");
    expect(main).toContain("isDeveloperIdSigned()");
    expect(main).toContain("Updates are enabled only in a Developer ID signed production companion.");
    expect(main).toContain("verifiedUpdate = null;\n    const xml = await fetchBounded(");
    expect(main).toContain("shell.showItemInFolder(destination)");
    expect(main).not.toContain("autoUpdater");
    expect(main).not.toContain("quitAndInstall");
    expect(main).not.toContain("response.arrayBuffer");

    expect(security).toContain('redirect: "manual"');
    expect(security).toContain("response.body.getReader()");
    expect(security).toContain("abortController.abort(failure)");
    expect(security).toContain("new SaxesParser({ xmlns: true })");
    expect(security).not.toContain("matchAll(");
    expect(packageJson.dependencies?.saxes).toBe("^6.0.0");
  });

  it("leaves durable preferences and the Windows broker lifecycle wired", () => {
    const main = readFileSync(join(process.cwd(), "electron", "main.cjs"), "utf8");
    expect(main).toContain("new BoundedSerialTaskQueue({");
    expect(main).toContain("preferenceWriteQueue.close();");
    expect(main).toContain("preferenceWriteQueue.drain(preferenceWriteDrainTimeoutMs)");
    expect(main).toContain("startWindowsPipeBrokerIfAvailable");
    expect(main).toContain("pipeBrokerRestartTimer = setTimeout");
  });
});

function canonicalAppcast(overrides: {
  prefix?: string;
  sha256?: string;
  shortVersion?: string;
  shortVersionAttribute?: string;
  signature?: string;
  url?: string;
  version?: string;
  versionAttribute?: string;
} = {}) {
  const prefix = overrides.prefix ?? "sparkle";
  const version = overrides.version ?? "176";
  const shortVersion = overrides.shortVersion ?? "0.1.0";
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:${prefix}="${updateSecurity.SPARKLE_NAMESPACE}">
  <channel>
    <title>Lekh Keyboard Updates</title>
    ${item({
      prefix,
      sha256: overrides.sha256,
      shortVersion,
      shortVersionAttribute: overrides.shortVersionAttribute,
      signature: overrides.signature,
      url: overrides.url,
      version,
      versionAttribute: overrides.versionAttribute
    })}
  </channel>
</rss>`;
}

function item(overrides: {
  prefix?: string;
  sha256?: string;
  shortVersion?: string;
  shortVersionAttribute?: string;
  signature?: string;
  url?: string;
  version?: string;
  versionAttribute?: string;
} = {}) {
  const prefix = overrides.prefix ?? "sparkle";
  const version = overrides.version ?? "176";
  const shortVersion = overrides.shortVersion ?? "0.1.0";
  return `<item>
      <title>Lekh Keyboard ${shortVersion}</title>
      <${prefix}:version>${version}</${prefix}:version>
      <${prefix}:shortVersionString>${shortVersion}</${prefix}:shortVersionString>
      <${prefix}:minimumAutoupdateVersion>${version}</${prefix}:minimumAutoupdateVersion>
      ${enclosure({
        prefix,
        sha256: overrides.sha256,
        shortVersion: overrides.shortVersionAttribute ?? shortVersion,
        signature: overrides.signature,
        url: overrides.url,
        version: overrides.versionAttribute ?? version
      })}
    </item>`;
}

function enclosure(overrides: {
  prefix?: string;
  sha256?: string;
  shortVersion?: string;
  signature?: string;
  url?: string;
  version?: string;
} = {}) {
  const prefix = overrides.prefix ?? "sparkle";
  return `<enclosure
        url="${overrides.url ?? `https://${pinnedHost}/updates/macos/Lekh.zip`}"
        ${prefix}:version="${overrides.version ?? "176"}"
        ${prefix}:shortVersionString="${overrides.shortVersion ?? "0.1.0"}"
        type="application/zip"
        length="5"
        ${prefix}:edSignature="${overrides.signature ?? signature}"
        ${prefix}:sha256="${overrides.sha256 ?? sha256}" />`;
}

function validatePinnedUrl(url: string) {
  updateSecurity.validatePinnedHttpsUrl(url, pinnedHost);
}

function mockResponse(options: {
  chunks: string[];
  contentLength?: string;
  location?: string;
  status?: number;
  url?: string;
}) {
  const chunks = options.chunks.map((chunk) => Buffer.from(chunk));
  let index = 0;
  const reader = {
    read: vi.fn(async () =>
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }
    ),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn()
  };
  const body: MockBody = {
    locked: false,
    cancel: vi.fn(async () => {}),
    getReader: vi.fn(() => reader)
  };
  const status = options.status ?? 200;
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  if (options.location !== undefined) headers.set("location", options.location);
  return {
    body,
    reader,
    value: {
      body,
      headers,
      ok: status >= 200 && status < 300,
      status,
      url: options.url ?? pinnedUrl
    } satisfies MockResponse
  };
}
