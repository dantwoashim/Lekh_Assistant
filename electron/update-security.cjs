"use strict";

const { SaxesParser } = require("saxes");

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
const APPCAST_ERROR = "The update appcast is malformed or unsigned.";
const RESPONSE_SIZE_ERROR = "Update response exceeds the size limit.";
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const criticalElementNames = new Map([
  ["version", { local: "version", target: "versionElement" }],
  ["shortversionstring", { local: "shortVersionString", target: "shortVersionElement" }],
  [
    "minimumautoupdateversion",
    { local: "minimumAutoupdateVersion", target: "minimumAutoupdateVersion" }
  ]
]);
const criticalAttributeNames = new Map([
  ["url", { local: "url", uri: "" }],
  ["version", { local: "version", uri: SPARKLE_NAMESPACE }],
  ["shortversionstring", { local: "shortVersionString", uri: SPARKLE_NAMESPACE }],
  ["sha256", { local: "sha256", uri: SPARKLE_NAMESPACE }],
  ["edsignature", { local: "edSignature", uri: SPARKLE_NAMESPACE }],
  ["length", { local: "length", uri: "" }],
  ["type", { local: "type", uri: "" }]
]);

async function fetchBounded(url, maximumBytes, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    headers = {},
    maximumRedirects = 5,
    timeoutMs = 15_000,
    validateUrl
  } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  if (typeof validateUrl !== "function") throw new TypeError("An update URL validator is required.");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("The update response limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 10) {
    throw new TypeError("The update redirect limit is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The update timeout must be a positive safe integer.");
  }

  let currentUrl = new URL(url).href;
  validateUrl(currentUrl);
  const abortController = new AbortController();
  const timeoutError = new Error("Update request timed out.");
  const timeout = setTimeout(() => abortController.abort(timeoutError), timeoutMs);
  let activeResponse = null;

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      activeResponse = await fetchImpl(currentUrl, {
        redirect: "manual",
        headers,
        signal: abortController.signal
      });
      const responseUrl =
        typeof activeResponse.url === "string" && activeResponse.url.length > 0
          ? activeResponse.url
          : currentUrl;
      validateUrl(responseUrl);

      if (redirectStatuses.has(activeResponse.status)) {
        if (redirectCount >= maximumRedirects) {
          throw new Error("Update response exceeded the redirect limit.");
        }
        const location = activeResponse.headers?.get?.("location");
        if (!location) throw new Error("Update redirect omitted its destination.");
        const nextUrl = new URL(location, responseUrl).href;
        validateUrl(nextUrl);
        await cancelResponseBody(activeResponse, new Error("Following validated update redirect."));
        activeResponse = null;
        currentUrl = nextUrl;
        continue;
      }

      if (!activeResponse.ok) {
        throw new Error(`Update server returned HTTP ${activeResponse.status}.`);
      }
      return await readResponseBodyBounded(activeResponse, maximumBytes, abortController);
    }
  } catch (error) {
    const failure = abortController.signal.aborted
      ? abortController.signal.reason instanceof Error
        ? abortController.signal.reason
        : new Error("Update request was aborted.")
      : error instanceof Error
        ? error
        : new Error(String(error));
    if (!abortController.signal.aborted) abortController.abort(failure);
    await cancelResponseBody(activeResponse, failure);
    throw failure;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBodyBounded(response, maximumBytes, abortController) {
  const declaredLength = parseContentLength(response.headers?.get?.("content-length"));
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new Error(RESPONSE_SIZE_ERROR);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Update response body is unavailable.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Update response yielded an invalid byte chunk.");
      }
      if (value.byteLength > maximumBytes - receivedBytes) {
        throw new Error(RESPONSE_SIZE_ERROR);
      }
      if (value.byteLength === 0) continue;
      chunks.push(Buffer.from(value));
      receivedBytes += value.byteLength;
    }
    return Buffer.concat(chunks, receivedBytes);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!abortController.signal.aborted) abortController.abort(failure);
    try {
      await reader.cancel(failure);
    } catch {
      // The fetch may already have torn the stream down after aborting.
    }
    throw failure;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed stream can already be detached from its reader.
    }
  }
}

function parseContentLength(value) {
  if (value === null || value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error("Update response has an invalid Content-Length.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Update response has an invalid Content-Length.");
  }
  return parsed;
}

async function cancelResponseBody(response, reason) {
  if (!response?.body || response.body.locked || typeof response.body.cancel !== "function") return;
  try {
    await response.body.cancel(reason);
  } catch {
    // Cancellation is best-effort after the request has already failed.
  }
}

function parseAppcast(input) {
  try {
    return parseAppcastStrict(decodeAppcastXml(input));
  } catch {
    throw new Error(APPCAST_ERROR);
  }
}

function decodeAppcastXml(input) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > 512 * 1024) throw new Error(APPCAST_ERROR);
    return input;
  }
  if (!(input instanceof Uint8Array) || input.byteLength > 512 * 1024) {
    throw new Error(APPCAST_ERROR);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(input);
}

function parseAppcastStrict(xml) {
  const stack = [];
  const state = {
    xmlDeclarations: 0,
    rss: 0,
    channels: 0,
    items: 0,
    enclosures: 0,
    versionElement: null,
    shortVersionElement: null,
    minimumAutoupdateVersion: null,
    enclosure: null
  };
  let capture = null;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("error", (error) => {
    throw error;
  });
  parser.on("xmldecl", (declaration) => {
    state.xmlDeclarations += 1;
    if (
      state.xmlDeclarations !== 1 ||
      declaration.version !== "1.0" ||
      (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")
    ) {
      throw new Error(APPCAST_ERROR);
    }
  });
  parser.on("doctype", () => {
    throw new Error(APPCAST_ERROR);
  });
  parser.on("processinginstruction", () => {
    throw new Error(APPCAST_ERROR);
  });
  parser.on("opentag", (node) => {
    stack.push({ local: node.local, uri: node.uri });
    if (capture && stack.length > capture.depth) throw new Error(APPCAST_ERROR);

    if (stack.length === 1) {
      if (!isElement(node, "rss")) throw new Error(APPCAST_ERROR);
      state.rss += 1;
      return;
    }

    if (node.local === "rss" && node.uri === "") throw new Error(APPCAST_ERROR);
    if (node.local === "channel" && node.uri === "") {
      if (!pathMatches(stack, ["rss", "channel"])) throw new Error(APPCAST_ERROR);
      state.channels += 1;
      if (state.channels !== 1) throw new Error(APPCAST_ERROR);
      return;
    }
    if (node.local === "item" && node.uri === "") {
      if (!pathMatches(stack, ["rss", "channel", "item"])) throw new Error(APPCAST_ERROR);
      state.items += 1;
      if (state.items !== 1) throw new Error(APPCAST_ERROR);
      return;
    }
    if (node.local === "enclosure" && node.uri === "") {
      if (!pathMatches(stack, ["rss", "channel", "item", "enclosure"])) {
        throw new Error(APPCAST_ERROR);
      }
      state.enclosures += 1;
      if (state.enclosures !== 1) throw new Error(APPCAST_ERROR);
      state.enclosure = parseEnclosureAttributes(node.attributes);
      return;
    }

    if (!insideCanonicalItem(stack)) return;
    const normalizedLocal = node.local.toLowerCase();
    const criticalElement = criticalElementNames.get(normalizedLocal);
    if (criticalElement) {
      const canonical =
        node.uri === SPARKLE_NAMESPACE &&
        node.local === criticalElement.local &&
        stack.length === 4;
      if (!canonical) throw new Error(APPCAST_ERROR);
      const { target } = criticalElement;
      if (state[target] !== null || capture) throw new Error(APPCAST_ERROR);
      capture = { depth: stack.length, target, value: "" };
      return;
    }
    if (node.uri === SPARKLE_NAMESPACE && criticalAttributeNames.has(normalizedLocal)) {
      throw new Error(APPCAST_ERROR);
    }
  });
  parser.on("text", (text) => appendCapturedText(capture, text));
  parser.on("cdata", (text) => appendCapturedText(capture, text));
  parser.on("closetag", () => {
    if (capture && capture.depth === stack.length) {
      state[capture.target] = capture.value.trim();
      capture = null;
    }
    stack.pop();
  });
  parser.write(xml).close();

  if (
    state.xmlDeclarations !== 1 ||
    state.rss !== 1 ||
    state.channels !== 1 ||
    state.items !== 1 ||
    state.enclosures !== 1 ||
    !state.enclosure ||
    state.versionElement !== state.enclosure.version ||
    state.shortVersionElement !== state.enclosure.shortVersion ||
    !state.minimumAutoupdateVersion
  ) {
    throw new Error(APPCAST_ERROR);
  }

  const details = {
    url: state.enclosure.url,
    version: state.enclosure.version,
    shortVersion: state.enclosure.shortVersion,
    minimumAutoupdateVersion: state.minimumAutoupdateVersion,
    length: Number(state.enclosure.length),
    type: state.enclosure.type,
    sha256: state.enclosure.sha256,
    signature: state.enclosure.signature
  };
  if (
    details.url.length === 0 ||
    details.url.length > 2048 ||
    !/^(?:0|[1-9]\d{0,17})$/.test(details.version) ||
    !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(
      details.shortVersion
    ) ||
    !/^(?:0|[1-9]\d{0,17})$/.test(details.minimumAutoupdateVersion) ||
    BigInt(details.minimumAutoupdateVersion) > BigInt(details.version) ||
    !/^(?:0|[1-9]\d{0,15})$/.test(state.enclosure.length) ||
    !Number.isSafeInteger(details.length) ||
    details.length <= 0 ||
    details.type !== "application/zip" ||
    !/^[a-f0-9]{64}$/i.test(details.sha256) ||
    !isCanonicalBase64(details.signature, 64)
  ) {
    throw new Error(APPCAST_ERROR);
  }
  return details;
}

function parseEnclosureAttributes(attributes) {
  const values = {};
  for (const attribute of Object.values(attributes)) {
    const expected = criticalAttributeNames.get(attribute.local.toLowerCase());
    if (!expected) continue;
    if (attribute.local !== expected.local || attribute.uri !== expected.uri) {
      throw new Error(APPCAST_ERROR);
    }
    const semanticName = attribute.local.toLowerCase();
    if (values[semanticName] !== undefined) throw new Error(APPCAST_ERROR);
    values[semanticName] = attribute.value;
  }
  for (const name of criticalAttributeNames.keys()) {
    if (values[name] === undefined) throw new Error(APPCAST_ERROR);
  }
  return {
    url: values.url,
    version: values.version,
    shortVersion: values.shortversionstring,
    sha256: values.sha256,
    signature: values.edsignature,
    length: values.length,
    type: values.type
  };
}

function appendCapturedText(capture, text) {
  if (!capture) return;
  capture.value += text;
  if (capture.value.length > 256) throw new Error(APPCAST_ERROR);
}

function isElement(node, local) {
  return node.local === local && node.uri === "";
}

function pathMatches(stack, locals) {
  return (
    stack.length === locals.length &&
    stack.every((node, index) => node.local === locals[index] && node.uri === "")
  );
}

function insideCanonicalItem(stack) {
  return (
    stack.length >= 3 &&
    stack[0].local === "rss" &&
    stack[0].uri === "" &&
    stack[1].local === "channel" &&
    stack[1].uri === "" &&
    stack[2].local === "item" &&
    stack[2].uri === ""
  );
}

function isCanonicalBase64(value, expectedBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === expectedBytes && decoded.toString("base64") === value;
}

function validatePinnedHttpsUrl(value, expectedHost) {
  if (
    typeof value !== "string" ||
    typeof expectedHost !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error("Update URL is outside the pinned HTTPS host.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Update URL is outside the pinned HTTPS host.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== expectedHost ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Update URL is outside the pinned HTTPS host.");
  }
  return parsed.href;
}

module.exports = {
  APPCAST_ERROR,
  RESPONSE_SIZE_ERROR,
  SPARKLE_NAMESPACE,
  fetchBounded,
  parseAppcast,
  validatePinnedHttpsUrl
};
