import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const skeleton = join(root, "native/windows-tsf/skeleton");
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows TSF source safety contract", () => {
  it("keeps host-app keys pass-through unless the opt-in slice is enabled", () => {
    const source = read("LekhTextService.cpp");
    expect(source).toContain("LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING");
    expect(source).toContain("!experimentalKeyEatingEnabled()");
    expect(source).toContain("*eaten = FALSE");
    expect(source).toContain("*eaten = processKey(context, wParam, lParam) ? TRUE : FALSE");
    expect(source).toContain("ToUnicodeEx");
    expect(source).toContain("GetKeyboardLayout(0)");
    expect(source).toContain("isRomanizedLetter(logicalKey(wParam, lParam))");
  });

  it("uses the supported TSF sink APIs and resets sessions on document lifecycle events", () => {
    const header = read("LekhTextService.h");
    const source = read("LekhTextService.cpp");
    expect(header).toContain("public ITfThreadMgrEventSink");
    expect(source).toContain("AdviseKeyEventSink(clientId_");
    expect(source).toContain("UnadviseKeyEventSink(clientId_)");
    expect(source).toContain("IID_ITfThreadMgrEventSink");
    expect(source).toContain("OnPushContext");
    expect(source).toContain("OnPopContext");
    expect(source).toContain("OnUninitDocumentMgr");
    expect(source).toContain("closeActiveContext(true)");
    expect(source).not.toContain("AdviseSink(IID_ITfKeyEventSink");
  });

  it("begins, validates, and ends real daemon sessions rather than inventing a client session id", () => {
    const source = read("LekhTextService.cpp");
    const protocol = read("TsfProtocol.cpp");
    expect(source).toContain("makeBeginSessionRequest");
    expect(source).toContain("makeProtocolNegotiationRequest");
    expect(source).toContain("parseProtocolNegotiationResponse");
    expect(source).toContain("parseBeginSessionResponse");
    expect(source).toContain("makeProcessKeyRequest");
    expect(source).toContain("parseProcessKeyResponse");
    expect(source).toContain("SessionCommand::End");
    expect(source).toContain("if (!lekh::tsf::finishActiveComposition(activeContext_, clientId_, &activeComposition_))");
    expect(protocol).toContain('L"session.begin"');
    expect(protocol).toContain('L"session.processKeyStroke"');
    expect(protocol).toContain("sessionId->string != expectedSession.sessionId");
    expect(protocol).toContain("hasSessionEpoch");
    expect(protocol).not.toContain('find(L"\\\"ok\\\":true")');
    expect(source).not.toContain("windows-tsf-dev");
  });

  it("uses synchronous TSF edit sessions for composition, commit, and cancel", () => {
    const editSession = read("TsfEditSession.cpp");
    expect(editSession).toContain("RequestEditSession");
    expect(editSession).toContain("TF_ES_SYNC | TF_ES_READWRITE");
    expect(editSession).toContain("InsertTextAtSelection");
    expect(editSession).toContain("StartComposition");
    expect(editSession).toContain("GetRange");
    expect(editSession).toContain("SetText");
    expect(editSession).toContain("EndComposition");
    expect(editSession).toContain("const bool applied = SUCCEEDED(requestResult) && editSession->hostTextMutated()");
    expect(editSession).toContain("if (SUCCEEDED(rollback)) hostTextMutated_ = false");
  });

  it("suppresses secure, private, PIN, and unclassified contexts", () => {
    const source = read("LekhTextService.cpp");
    const editSession = read("TsfEditSession.cpp");
    expect(source).toContain("TF_TMAE_SECUREMODE");
    expect(source).toContain("privacy != lekh::tsf::ContextPrivacy::Safe");
    expect(editSession).toContain("GUID_PROP_INPUTSCOPE");
    expect(editSession).toContain("IS_PASSWORD");
    expect(editSession).toContain("IS_PRIVATE");
    expect(editSession).toContain("IS_NUMERIC_PASSWORD");
    expect(editSession).toContain("IS_NUMERIC_PIN");
    expect(editSession).toContain("IS_ALPHANUMERIC_PIN");
    expect(editSession).toContain("ContextPrivacy::Unknown");
    expect(editSession).toContain("isKnownInputScope");
    expect(editSession).toContain("!isKnownInputScope(scopes[index])");
  });

  it("does not consume unsupported candidate or navigation keys without a native UI", () => {
    const source = read("LekhTextService.cpp");
    const handleBlock = source.slice(
      source.indexOf("bool LekhTextService::shouldHandleKey"),
      source.indexOf("bool LekhTextService::experimentalKeyEatingEnabled")
    );
    expect(handleBlock).toContain("if (!activeComposition_) return false");
    expect(handleBlock).toContain("VK_SPACE");
    expect(handleBlock).toContain("VK_BACK");
    expect(handleBlock).toContain("VK_RETURN");
    expect(handleBlock).toContain("VK_ESCAPE");
    expect(handleBlock).not.toContain("VK_TAB");
    expect(handleBlock).not.toContain("VK_DELETE");
  });

  it("uses a per-user pipe and cancellation-safe bounded overlapped IO", () => {
    const ipc = read("IpcClient.cpp");
    const guids = read("Guids.h");
    expect(ipc).toContain("ConvertSidToStringSidW");
    expect(ipc).toContain("GetNamedPipeServerProcessId");
    expect(ipc).toContain("EqualSid");
    expect(ipc).toContain("pipeServerRunsAsCurrentUser(pipe)");
    expect(ipc).toContain("LEKH_KEYBOARD_PIPE_NAME");
    expect(guids).toContain("kLekhPipeNamePrefix");
    expect(ipc).toContain("FILE_FLAG_OVERLAPPED");
    expect(ipc).toContain("WaitForSingleObject");
    expect(ipc).toContain("CancelIoEx(handle, &overlapped)");
    expect(ipc).toContain("GetOverlappedResult(handle, &overlapped, &ignoredBytes, TRUE)");
    expect(ipc).toContain("lekh::ipc::kMaximumFrameBytes");
    expect(guids).toContain("lekh::ipc::kHotPathDeadlineMilliseconds");
    expect(ipc).toContain("readLineWithDeadline");
    expect(ipc).toContain("remainingTimeout(startedAt, timeoutMs)");
    expect(ipc).not.toContain("PIPE_READMODE_MESSAGE");
  });

  it.skipIf(process.platform === "win32")("compiles and runs the portable native protocol tests", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "lekh-tsf-protocol-"));
    temporaryDirectories.push(temporaryDirectory);
    const executable = join(temporaryDirectory, "TsfProtocolTests");
    const build = spawnSync("c++", [
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      join(skeleton, "TsfProtocol.cpp"),
      join(skeleton, "TsfProtocolTests.cpp"),
      "-o",
      executable
    ], { encoding: "utf8" });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    const run = spawnSync(executable, [], { encoding: "utf8" });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("TSF protocol v2 tests passed");
  });
});

function read(file: string): string {
  return readFileSync(join(skeleton, file), "utf8");
}
