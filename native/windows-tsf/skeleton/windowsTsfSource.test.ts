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
  it("keeps OnTestKeyDown predictive and consumes only an accepted real-key edit", () => {
    const source = read("LekhTextService.cpp");
    const header = read("LekhTextService.h");
    const testBlock = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown")
    );
    const keyBlock = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyUp")
    );
    expect(source).not.toContain("LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING");
    expect(header).not.toContain("experimentalKeyEatingEnabled");
    expect(testBlock).toContain("shouldHandleKey(wParam, lParam)");
    expect(testBlock).not.toContain("prepareSafeContext");
    expect(testBlock).not.toContain("beginDaemonSession");
    expect(testBlock).not.toContain("ipc_.request");
    expect(keyBlock).toContain("!prepareSafeContext(context)");
    expect(keyBlock).toContain("processKey(context, wParam, lParam)");
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

  it("exports the complete COM and self-registration surface from the TSF DLL", () => {
    const cmake = read("CMakeLists.txt");
    const exports = read("LekhTextService.def");
    const registration = read("Register.cpp");
    expect(cmake).toContain("LekhTextService.def");
    expect(exports).toContain("DllCanUnloadNow PRIVATE");
    expect(exports).toContain("DllGetClassObject PRIVATE");
    expect(exports).toContain("DllRegisterServer PRIVATE");
    expect(exports).toContain("DllUnregisterServer PRIVATE");
    expect(registration).toContain("kMaximumWindowsPathCharacters = 32768");
    expect(registration).toContain("currentModulePath(&modulePath)");
    expect(registration).toContain("GUID_TFCAT_TIP_KEYBOARD");
    expect(registration).toContain("GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER");
    expect(registration).toContain("GUID_TFCAT_TIPCAP_IMMERSIVESUPPORT");
    expect(registration).toContain("UnregisterCategory");
    expect(registration).toContain("iconPath.data()");
    expect(read("LekhTextService.rc")).toContain("IDI_LEKH_IME ICON");
    expect(registration).toContain("LoadLibraryExW(L\"input.dll\", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32)");
    expect(registration).toContain('GetProcAddress(input, "InstallLayoutOrTip")');
    expect(registration).toContain("setTextServiceEnabledForCurrentUser(true)");
    expect(registration).toContain("setTextServiceEnabledForCurrentUser(false)");
    expect(registration).not.toContain("kInstallLayoutOrTipDefault");
    expect(cmake).toContain("LekhTextService.rc");
    expect(registration).not.toContain("modulePath[MAX_PATH]");
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
    expect(source).toContain("submitFinishComposition");
    expect(source).toContain("abandonCompositionState");
    expect(protocol).toContain('L"session.begin"');
    expect(protocol).toContain('L"session.processKeyStroke"');
    expect(protocol).toContain("sessionId->string != expectedSession.sessionId");
    expect(protocol).toContain("hasSessionEpoch");
    expect(protocol).not.toContain('find(L"\\\"ok\\\":true")');
    expect(source).not.toContain("windows-tsf-dev");
  });

  it("owns asynchronous composition edits and falls open inside the accepted edit session", () => {
    const editSession = read("TsfEditSession.cpp");
    const serviceHeader = read("LekhTextService.h");
    const service = read("LekhTextService.cpp");
    const attributes = read("DisplayAttributes.cpp");
    const registration = read("Register.cpp");
    expect(editSession).toContain("TF_ES_ASYNCDONTCARE | TF_ES_READWRITE");
    expect(editSession).toContain("TF_ES_ASYNCDONTCARE | TF_ES_READ");
    expect(service).toContain("primeFocusedContext()");
    expect(service).toContain("submitContextPrivacyInspection");
    expect(editSession).not.toContain("TF_ES_SYNC | TF_ES_READWRITE");
    expect(editSession).toContain("TF_IAS_QUERYONLY");
    expect(editSession.indexOf("TF_IAS_QUERYONLY")).toBeLessThan(editSession.indexOf("compositionContext->StartComposition"));
    expect(editSession.indexOf("compositionContext->StartComposition")).toBeLessThan(editSession.indexOf("setRangeText(editCookie, compositionRange, text)"));
    expect(editSession).toContain("class CompositionState final : public ITfCompositionSink");
    expect(editSession).toContain("OnCompositionTerminated");
    expect(editSession).toContain("compositionCreationAlreadyFailed");
    expect(editSession).toContain("insertPlainText(editCookie, failOpenText_");
    expect(editSession).toContain("callback_.function(callback_.context, finalOutcome)");
    expect(service).toContain("candidateWindow_.post");
    expect(service).toContain("scheduleCommittedCandidateLearning(outcome.decision.commitEpoch)");
    expect(serviceHeader).toContain("public ITfDisplayAttributeProvider");
    expect(service).toContain("registerCompositionDisplayAttribute");
    expect(service).toContain("registerGhostDisplayAttribute");
    expect(attributes).toContain("IID_ITfDisplayAttributeInfo");
    expect(attributes).toContain("COLOR_GRAYTEXT");
    expect(attributes).toContain("TF_ATTR_INPUT");
    expect(editSession).toContain("GUID_PROP_ATTRIBUTE");
    expect(editSession).toContain("property->SetValue(editCookie, range, &value)");
    expect(editSession).toContain("property->Clear(editCookie, range)");
    expect(editSession).toContain("decision_.inlineCompletionDisplayText");
    expect(registration).toContain("GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER");
  });

  it("suppresses explicit secure contexts without disabling ordinary Win32 fields", () => {
    const source = read("LekhTextService.cpp");
    const serviceHeader = read("LekhTextService.h");
    const editSession = read("TsfEditSession.cpp");
    const inputScopeGuids = read("InputScopeGuids.cpp");
    expect(source).toContain("TF_TMAE_SECUREMODE");
    expect(source).toContain("contextPrivacy_ != lekh::tsf::ContextPrivacy::Safe");
    expect(editSession).toContain("GUID_PROP_INPUTSCOPE");
    expect(editSession).toContain("GUID_COMPARTMENT_KEYBOARD_DISABLED");
    expect(editSession).toContain("GUID_COMPARTMENT_EMPTYCONTEXT");
    expect(editSession).toContain("IID_ITfCompartmentMgr");
    expect(editSession).toContain("IS_PASSWORD");
    expect(editSession).toContain("IS_PRIVATE");
    expect(editSession).toContain("IS_NUMERIC_PASSWORD");
    expect(editSession).toContain("IS_NUMERIC_PIN");
    expect(editSession).toContain("IS_ALPHANUMERIC_PIN");
    expect(editSession).toContain("hr == S_FALSE || hr == E_NOTIMPL");
    expect(editSession).toContain("value.vt == VT_EMPTY || value.vt == VT_NULL");
    expect(editSession).not.toContain("hr == E_FAIL || hr == E_NOTIMPL");
    expect(editSession).toContain("if (scopeCount == 0)");
    expect(editSession).toContain("*classification = ContextPrivacy::Safe");
    expect(editSession).toContain("privacy != ContextPrivacy::Safe");
    expect(serviceHeader).toContain("public ITfTextEditSink");
    expect(source).toContain("GetSelectionStatus");
    expect(source).toContain("GetTextAndPropertyUpdates");
    expect(editSession).toContain("ContextPrivacy::Unknown");
    expect(editSession).toContain("isKnownInputScope");
    expect(editSession).toContain("!isKnownInputScope(scopes[index])");
    expect(inputScopeGuids).toContain("<initguid.h>");
    expect(inputScopeGuids).toContain("<inputscope.h>");
    expect(read("CMakeLists.txt")).toContain("InputScopeGuids.cpp");
  });

  it("loads per-user Windows preferences and fails closed when an app identity is unavailable", () => {
    const source = read("LekhTextService.cpp");
    const preferences = read("WindowsPreferences.cpp");
    const cmake = read("CMakeLists.txt");
    expect(source).toContain("preferences_ = lekh::tsf::readWindowsPreferences()");
    expect(source).toContain("personalizationAllowedForForegroundApplication(preferences_)");
    expect(source).toContain("TF_TMF_IMMERSIVEMODE");
    expect(preferences).toContain("if (!preferences.personalizationEnabled) return false");
    expect(preferences).toContain("if (!identifier) return false");
    expect(preferences).toContain('return L"win32.exe:" + executable');
    expect(cmake).toContain("add_library(LekhWindowsPreferences STATIC");
  });

  it("renders and navigates the bounded native candidate list without taking focus", () => {
    const source = read("LekhTextService.cpp");
    const header = read("LekhTextService.h");
    const state = read("CandidateState.cpp");
    const window = read("CandidateWindow.cpp");
    const accessibility = read("CandidateAccessibility.cpp");
    const editSession = read("TsfEditSession.cpp");
    const protocol = read("TsfProtocol.cpp");
    const cmake = read("CMakeLists.txt");
    const handleBlock = source.slice(
      source.indexOf("bool LekhTextService::shouldHandleKey"),
      source.indexOf("bool LekhTextService::prepareSafeContext")
    );
    expect(header).toContain("lekh::tsf::CandidateState candidateState_");
    expect(header).toContain("lekh::tsf::CandidateWindow candidateWindow_");
    expect(handleBlock).toContain("candidateState_.visible() && candidateCommand(wParam)");
    expect(handleBlock).toContain("compositionStateIsActive(compositionState_)");
    expect(source).toContain("VK_UP");
    expect(source).toContain("VK_DOWN");
    expect(source).toContain("CandidateCommand::Digit1");
    expect(source).toContain("CandidateCommand::Digit8");
    expect(source).toContain("CandidateCommand::ConfirmWithSpace");
    expect(source).toContain("CandidateCommand::ConfirmWithEnter");
    expect(source).toContain("makeCommitCandidateRequest");
    expect(source).toContain("parseCommitCandidateResponse");
    expect(state).toContain("CandidateInteractionType::SelectionChanged");
    expect(state).toContain("CandidateInteractionType::CommitRequested");
    expect(protocol).toContain("kMaximumCandidateCount");
    expect(window).toContain("CreateWindowExW");
    expect(window).toContain("WS_EX_NOACTIVATE");
    expect(window).toContain("SWP_NOACTIVATE | SWP_SHOWWINDOW");
    expect(window).toContain("GWLP_HWNDPARENT");
    expect(window).toContain("EVENT_OBJECT_IME_SHOW");
    expect(window).toContain("EVENT_OBJECT_IME_HIDE");
    expect(window).toContain("EVENT_OBJECT_IME_CHANGE");
    expect(window).toContain("WM_GETOBJECT");
    expect(window).toContain("WM_LBUTTONUP");
    expect(window).toContain("MA_NOACTIVATE");
    expect(window).not.toContain("HTTRANSPARENT");
    expect(window).not.toContain("MA_NOACTIVATEANDEAT");
    expect(source).toContain("setCandidateInvokedCallback");
    expect(window).toContain("DrawTextW");
    expect(editSession).toContain("GetActiveView");
    expect(editSession).toContain("GetWnd(&outcome_.candidateOwnerWindow)");
    expect(editSession).toContain("GetTextExt(editCookie, range, &extent, &clipped)");
    expect(window).toContain("textAnchor_.value_or(fallbackCandidateAnchor())");
    expect(window).toContain("DT_END_ELLIPSIS");
    expect(window).toContain('L"Nirmala UI"');
    expect(source).toContain("TF_TMAE_UIELEMENTENABLEDONLY");
    expect(accessibility).toContain('L"IME_Candidate_Window"');
    expect(accessibility).toContain("UIA_MenuOpenedEventId");
    expect(accessibility).toContain("UIA_MenuClosedEventId");
    expect(accessibility).toContain("UIA_SelectionItem_ElementSelectedEventId");
    expect(accessibility).toContain("UIA_SelectionItemIsSelectedPropertyId");
    expect(accessibility).toContain("kCandidateAccessibilitySelectMessage");
    expect(accessibility).toContain("PostMessageW");
    expect(accessibility).toContain("UIA_NamePropertyId");
    expect(cmake).toContain("CandidateAccessibility.cpp");
    expect(cmake).toContain("uiautomationcore");
    expect(cmake).toContain("add_executable(LekhCandidateStateTests");
    expect(cmake).toContain("add_test(NAME LekhCandidateStateTests");
    expect(handleBlock).toContain("activeGhostVisible_");
    expect(handleBlock).toContain("wParam == VK_TAB || wParam == VK_RIGHT");
    expect(handleBlock).not.toContain("VK_DELETE");
  });

  it("uses a per-user pipe and cancellation-safe bounded overlapped IO", () => {
    const ipc = read("IpcClient.cpp");
    const identity = read("LekhWindowsIdentity.cpp");
    const serverIdentity = read("LekhPipeServerIdentity.cpp");
    const guids = read("Guids.h");
    expect(identity).toContain("ConvertSidToStringSidW");
    expect(identity).toContain("std::vector<DWORD>");
    expect(identity).not.toContain("std::vector<BYTE>");
    expect(serverIdentity).toContain("GetNamedPipeServerProcessId");
    expect(identity).toContain("EqualSid");
    expect(serverIdentity).toContain("processRunsAsCurrentUser(process)");
    expect(serverIdentity).toContain('L"LekhPipeBroker.exe"');
    expect(serverIdentity).toContain("QueryFullProcessImageNameW");
    expect(serverIdentity).toContain("GetFileInformationByHandle");
    expect(ipc).toContain("serverIsTrustedBroker(pipe, g_module)");
    expect(ipc).toContain("if (!sid || sid->empty()) return std::nullopt");
    expect(ipc).toContain("if (pipeName_.empty()) return std::nullopt");
    expect(ipc).not.toContain("LEKH_KEYBOARD_PIPE_NAME");
    expect(guids).not.toContain("kLekhPipeNameFallback");
    expect(guids).toContain("kLekhPipeNamePrefix");
    expect(ipc).toContain("FILE_FLAG_OVERLAPPED");
    expect(ipc).toContain("WaitForSingleObject");
    expect(ipc).toContain("CancelIoEx(handle, &overlapped)");
    expect(ipc).toContain("GetOverlappedResult(handle, &overlapped, &ignoredBytes, TRUE)");
    expect(ipc).toContain("lekh::ipc::kMaximumFrameBytes");
    expect(guids).toContain("lekh::ipc::kHotPathDeadlineMilliseconds");
    expect(ipc).toContain("readLineWithDeadline");
    expect(ipc).toContain("kTransportCompletionGraceMilliseconds = 15");
    expect(ipc).toContain("transportTimeout(timeoutMs)");
    expect(ipc).toContain("remainingTimeout(startedAt, timeoutMs)");
    expect(ipc).not.toContain("PIPE_READMODE_MESSAGE");
  });

  it("builds and verifies a protected logon-session pipe DACL", () => {
    const security = read("LekhPipeSecurity.cpp");
    const identity = read("LekhWindowsIdentity.cpp");
    const securityTest = read("LekhPipeSecurityTests.cpp");
    const cmake = read("CMakeLists.txt");
    expect(identity).toContain("TokenGroups");
    expect(identity).toContain("SE_GROUP_LOGON_ID");
    expect(security).toContain("currentUserSid()");
    expect(security).toContain('L"D:P(A;;GA;;;SY)"');
    expect(security).toContain('L"D:P(A;;GA;;;SY)(A;;GA;;;"');
    expect(security).toContain("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    expect(security).toContain("GetSecurityInfo");
    expect(security).toContain("SE_DACL_PROTECTED");
    expect(security).toContain("dacl->AceCount != expectedAceCount");
    expect(securityTest).toContain("FILE_FLAG_FIRST_PIPE_INSTANCE");
    expect(securityTest).toContain("PIPE_REJECT_REMOTE_CLIENTS");
    expect(securityTest).toContain("validatePipeHandle(pipe)");
    expect(cmake).toContain("add_library(LekhPipeSecurity STATIC");
    expect(cmake).toContain("add_executable(LekhPipeSecurityTests");
    expect(cmake).toContain("add_test(NAME LekhPipeSecurityTests");
  });

  it("routes the public endpoint through the contained native broker", () => {
    const broker = read("LekhPipeBroker.cpp");
    const backend = read("LekhDaemonBackend.cpp");
    const generatedProtocol = readFileSync(
      join(root, "native/shared/ipc/generated/LekhIPCProtocol.generated.h"),
      "utf8"
    );
    const cmake = read("CMakeLists.txt");
    const companion = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(broker).toContain("CreateNamedPipeW");
    expect(broker).toContain("FILE_FLAG_FIRST_PIPE_INSTANCE");
    expect(broker).toContain("PIPE_REJECT_REMOTE_CLIENTS");
    expect(broker).toContain("security.validatePipeHandle(pipe.get())");
    expect(broker).toContain("lekh::ipc::kMaximumActiveConnections");
    expect(generatedProtocol).toContain("kControlDeadlineMilliseconds = 5000");
    expect(broker).toContain("lekh::ipc::kControlDeadlineMilliseconds");
    expect(broker).toContain("readClientFrame(pipe, requestReadDeadline)");
    expect(broker).toContain("inspectRequestTiming(wideRequest)");
    expect(broker).toContain("operationDeadlineFor(timing)");
    expect(broker).toContain("responseDeadlineFor(*operationDeadline)");
    expect(broker).toContain("FlushFileBuffers(pipe)");
    expect(broker).toContain("verifyBackendReadiness(backend)");
    expect(broker).toContain("makeProtocolNegotiationRequest(metadata)");
    expect(broker).toContain("makeEngineWarmRequest(warmMetadata");
    expect(broker.indexOf("verifyBackendReadiness(backend)")).toBeLessThan(broker.indexOf("createClientPipe(*name"));
    expect(broker).toContain("kMaximumConnections - kWorkerCount - 1");
    expect(backend).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(backend).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(backend).toContain('L"NODE_OPTIONS"');
    expect(backend).toContain('L"NODE_PATH"');
    expect(backend).toContain("GetOverlappedResultEx");
    expect(backend).toContain("std::timed_mutex");
    expect(backend).toContain("if (!response) poison()");
    expect(backend).toContain("CREATE_SUSPENDED | CREATE_NO_WINDOW");
    expect(cmake).toContain("add_executable(LekhPipeBroker WIN32");
    expect(cmake).toContain("add_executable(LekhDaemonBackendTests");
    expect(companion).toContain("startWindowsPipeBrokerIfAvailable()");
    expect(companion).toContain('spawn(brokerPath, []');
    expect(companion).not.toContain('[daemonPath, "--named-pipe"]');
    expect(companion).toContain('label: "Exit Lekh Keyboard Companion"');
    expect(companion).toContain("click: () => app.quit()");
  });

  it("ships a focused first-composition host instead of a headless or direct-injection-only probe", () => {
    const integration = read("TsfInjectionTests.cpp");
    expect(integration).toContain("CreateWindowExW");
    expect(integration).toContain("SetForegroundWindow(window)");
    expect(integration).toContain("AssociateFocus(window_, documentManager_");
    expect(integration).toContain("forceAsyncWrites");
    expect(integration).toContain("TS_S_ASYNC");
    expect(integration).toContain("lockFlags & TS_LF_SYNC");
    expect(integration).toContain("sink_->OnLockGranted(access)");
    expect(integration).toContain("testAsyncPrivacyInspection");
    expect(integration).toContain("testAsyncFirstComposition");
    expect(integration).toContain("testCompositionFailureFallsBackExactlyOnce");
    expect(integration).toContain("testRejectedEditPassesThrough");
    expect(integration).toContain("ActivateProfile(");
    expect(integration).toContain("live first key did not create a Devanagari composition");
    expect(integration).not.toContain("LekhGetLiveDiagnosticState");
    expect(integration).not.toContain("LekhTextService-live3.dll");
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

    const candidateExecutable = join(temporaryDirectory, "CandidateStateTests");
    const candidateBuild = spawnSync("c++", [
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      join(skeleton, "CandidateState.cpp"),
      join(skeleton, "CandidateStateTests.cpp"),
      "-o",
      candidateExecutable
    ], { encoding: "utf8" });
    expect(candidateBuild.status, `${candidateBuild.stdout}\n${candidateBuild.stderr}`).toBe(0);

    const candidateRun = spawnSync(candidateExecutable, [], { encoding: "utf8" });
    expect(candidateRun.status, `${candidateRun.stdout}\n${candidateRun.stderr}`).toBe(0);
    expect(candidateRun.stdout).toContain("Candidate state navigation tests passed");
  }, 60_000);
});

function read(file: string): string {
  return readFileSync(join(skeleton, file), "utf8");
}
