import { spawnSync } from "node:child_process";

function exactKeys(value, expected) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

const snapshotKeys = Object.freeze([
  "appFrontmost",
  "documents",
  "editorFocused",
  "exactDocumentCount",
  "focusedUIElementMatchesEditor",
  "frontmostPid",
  "operationStatus",
  "targetPid",
  "textBase64",
  "windowFocused",
  "windowMain"
]);

/**
 * Produces a strictly observational Accessibility query. This source must not
 * activate an application, set an AX attribute, move focus, or post an input
 * event: a postcondition probe is evidence only when it cannot repair the
 * condition it is trying to prove.
 */
export function passiveExactTextEditInspectionSource(pid, realDocumentPath) {
  if (!Number.isInteger(pid) || pid <= 1) throw new TypeError("A valid TextEdit PID is required.");
  if (typeof realDocumentPath !== "string" || !realDocumentPath.startsWith("/")) {
    throw new TypeError("An absolute TextEdit document path is required.");
  }
  const expectedPathBase64 = Buffer.from(realDocumentPath, "utf8").toString("base64");
  return `
import AppKit
import ApplicationServices
import Foundation

let targetPid = pid_t(${pid})
guard let expectedPathData = Data(base64Encoded: ${JSON.stringify(expectedPathBase64)}),
      let expectedPath = String(data: expectedPathData, encoding: .utf8) else { exit(2) }

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool {
  attribute(element, name) as? Bool ?? false
}

func canonicalDocumentPath(_ raw: String) -> String {
  let url: URL
  if raw.hasPrefix("file:"), let fileURL = URL(string: raw) {
    url = fileURL
  } else {
    url = URL(fileURLWithPath: raw)
  }
  return url.standardizedFileURL.resolvingSymlinksInPath().path
}

func textArea(in element: AXUIElement, depth: Int = 0) -> AXUIElement? {
  guard depth < 12 else { return nil }
  if stringAttribute(element, kAXRoleAttribute as CFString) == (kAXTextAreaRole as String) {
    return element
  }
  let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
  for child in children {
    if let match = textArea(in: child, depth: depth + 1) { return match }
  }
  return nil
}

let canonicalExpectedPath = canonicalDocumentPath(expectedPath)
let app = AXUIElementCreateApplication(targetPid)
let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
var documents: [String] = []
var exactWindows: [AXUIElement] = []
for window in windows {
  let raw = stringAttribute(window, kAXDocumentAttribute as CFString)
  guard !raw.isEmpty else { continue }
  let path = canonicalDocumentPath(raw)
  documents.append(path)
  if path == canonicalExpectedPath { exactWindows.append(window) }
}

var textValue: String? = nil
var operationStatus = "document-not-found"
var windowMain = false
var windowFocused = false
var editorFocused = false
var focusedUIElementMatchesEditor = false
if exactWindows.count == 1, documents.count == 1, let window = exactWindows.first {
  windowMain = boolAttribute(window, kAXMainAttribute as CFString)
  windowFocused = boolAttribute(window, kAXFocusedAttribute as CFString)
  if let editor = textArea(in: window) {
    operationStatus = "passive-inspected"
    editorFocused = boolAttribute(editor, kAXFocusedAttribute as CFString)
    if let focused = attribute(app, kAXFocusedUIElementAttribute as CFString) {
      focusedUIElementMatchesEditor = CFEqual(focused, editor)
    }
    textValue = attribute(editor, kAXValueAttribute as CFString) as? String
  } else {
    operationStatus = "text-area-not-found"
  }
} else if exactWindows.count > 1 || documents.count > 1 {
  operationStatus = "unexpected-documents"
}

let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
let appFrontmost = boolAttribute(app, kAXFrontmostAttribute as CFString)
let textBase64 = textValue?.data(using: .utf8)?.base64EncodedString() ?? ""
let output: [String: Any] = [
  "appFrontmost": appFrontmost,
  "documents": documents,
  "editorFocused": editorFocused,
  "exactDocumentCount": exactWindows.count,
  "focusedUIElementMatchesEditor": focusedUIElementMatchesEditor,
  "frontmostPid": frontmostPid,
  "operationStatus": operationStatus,
  "targetPid": targetPid,
  "textBase64": textBase64,
  "windowFocused": windowFocused,
  "windowMain": windowMain
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`;
}

export function inspectExactTextEditPassively(pid, realDocumentPath, {
  runner = spawnSync
} = {}) {
  let source;
  try {
    source = passiveExactTextEditInspectionSource(pid, realDocumentPath);
  } catch (error) {
    return {
      status: 2,
      snapshot: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
  const result = runner("/usr/bin/swift", ["-e", source], { encoding: "utf8" });
  const line = typeof result?.stdout === "string"
    ? result.stdout.trim().split(/\r?\n/u).at(-1) ?? ""
    : "";
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Malformed output is a failed observation and never permission to repair.
  }
  const snapshot = exactKeys(parsed, snapshotKeys) &&
    typeof parsed.textBase64 === "string" &&
    typeof parsed.operationStatus === "string" &&
    Array.isArray(parsed.documents) &&
    parsed.documents.every((path) => typeof path === "string") &&
    Buffer.from(parsed.textBase64, "base64").toString("base64") === parsed.textBase64
    ? {
        ...parsed,
        text: parsed.textBase64
          ? Buffer.from(parsed.textBase64, "base64").toString("utf8")
          : ""
      }
    : null;
  const exactDocument = snapshot?.targetPid === pid &&
    snapshot?.exactDocumentCount === 1 &&
    snapshot?.documents?.length === 1 &&
    snapshot?.documents?.[0] === realDocumentPath &&
    snapshot?.operationStatus === "passive-inspected";
  const exactFocus = snapshot?.frontmostPid === pid &&
    snapshot?.appFrontmost === true &&
    snapshot?.windowMain === true &&
    snapshot?.windowFocused === true &&
    snapshot?.editorFocused === true &&
    snapshot?.focusedUIElementMatchesEditor === true;
  const valid = result?.status === 0 && exactDocument && exactFocus;
  return {
    status: valid ? 0 : Number.isInteger(result?.status) && result.status !== 0 ? result.status : 3,
    snapshot,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : ""
  };
}
