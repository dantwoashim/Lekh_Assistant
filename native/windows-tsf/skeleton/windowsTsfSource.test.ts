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
    expect(source).toContain(
      "*eaten = processKey(context, wParam, lParam) ? TRUE : FALSE",
    );
    expect(source).toContain("ToUnicodeEx");
    expect(source).toContain('case 0x1e: return L"KeyA";');
    expect(source).toContain('case 0x15: return L"KeyY";');
    expect(source).toContain("GetKeyboardLayout(0)");
    expect(source).toContain("isRomanizedLetter(logicalKey(wParam, lParam))");
    const testKeyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
    );
    expect(testKeyDown).toContain("shouldHandleKey(wParam, lParam)");
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
    expect(source).toContain("closeActiveContextForLifecycle(true)");
    expect(source).toContain("documentManagerIsCurrentFocus");
    expect(source).toContain("documentManagerIsActive");
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
    expect(source).toContain("lekh::tsf::finishActiveComposition(");
    expect(protocol).toContain('L"session.begin"');
    expect(protocol).toContain('L"session.processKeyStroke"');
    expect(protocol).toContain(
      "sessionId->string != expectedSession.sessionId",
    );
    expect(protocol).toContain("hasSessionEpoch");
    expect(protocol).toContain("expectedCompositionText + expectedKey.key");
    expect(protocol).toContain(
      "decision.compositionText == expectedNextComposition",
    );
    expect(protocol).toContain("candidateMatchesFirst(*primary, candidates)");
    expect(protocol).toContain("decision.committedText == expectedCommit");
    expect(protocol).not.toContain("passiveDelimiterPolicy");
    expect(protocol).not.toContain('find(L"\\\"ok\\\":true")');
    expect(source).not.toContain("windows-tsf-dev");
  });

  it("keeps startup off the key callback and bounds opaque retirement requests", () => {
    const source = read("LekhTextService.cpp");
    const retirement = read("DaemonRetirement.h");
    const dllMain = read("DllMain.cpp");
    const testKeyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
    );
    const keyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyUp"),
    );
    const processKey = source.slice(
      source.indexOf("bool LekhTextService::processKey"),
      source.indexOf("void LekhTextService::retireDaemonSession"),
    );
    const abandonSession = source.slice(
      source.indexOf("LekhTextService::abandonSensitiveSession"),
      source.indexOf("void LekhTextService::quarantineAppliedDaemonSession"),
    );
    const retireSession = source.slice(
      source.indexOf("void LekhTextService::retireDaemonSession"),
      source.indexOf("void LekhTextService::endDaemonSession"),
    );
    const sessionReady = source.slice(
      source.indexOf("bool LekhTextService::sessionReadyForContext"),
      source.indexOf("bool LekhTextService::prepareSafeContext"),
    );

    expect(testKeyDown).toContain("sessionStateReadyForContext(context)");
    expect(testKeyDown).toContain("!acceptsKeystrokes_");
    expect(testKeyDown).not.toContain("prepareSafeContext");
    expect(testKeyDown).not.toContain("inspectContextPrivacy");
    expect(keyDown).toContain("sessionReadyForContext(context)");
    expect(keyDown).toContain("!acceptsKeystrokes_");
    expect(keyDown).not.toContain("prepareSafeContext");
    expect(processKey.match(/ipc_\.request\(/g)).toHaveLength(1);
    expect(processKey).not.toContain("beginDaemonSession");
    expect(processKey).not.toContain("negotiateDaemon");
    expect(processKey).not.toContain("warmDaemon");
    expect(processKey).not.toContain("endDaemonSession");
    expect(processKey).not.toContain("makeSessionRequest");
    expect(processKey).toContain("compositionText_");
    expect(abandonSession).not.toContain("ipc_.request");
    expect(abandonSession).not.toContain("endDaemonSession");
    expect(abandonSession).toContain("retireDaemonSession(");
    expect(abandonSession).toContain("SessionCommand::End");
    expect(retirement).toContain("kRetirementAttemptTimeoutMilliseconds = 100");
    expect(retirement).toContain("kMaximumRetirementAttempts = 3");
    expect(retirement).toContain("DaemonRetirementState::Quarantined");
    expect(source).toContain("deliverExactRetirement");
    expect(source).toContain("parseSessionResponse");
    expect(source).toContain("deliverClientPurge");
    expect(source).toContain("parseProtocolNegotiationResponse");
    expect(source).toContain("requestSequenceLane->fetch_add");
    expect(source).toContain("PostMessageW");
    expect(source).toContain("InterlockedIncrement64(&g_nextCompletionToken)");
    expect(source).toContain("retirementCompletionTokenMatches(");
    expect(source).toContain("retirementCompletionTarget_->window = completionWindow_");
    expect(source).toContain("work->completionTarget->window");
    expect(source).toContain("completionWindowClassName_ = kRetirementCompletionWindowClassPrefix");
    expect(source).toContain("UnregisterClassW(completionWindowClassName_.c_str(), g_module)");
    expect(source).toContain("catch (...)");
    expect(retireSession).not.toContain("ipc_.request");
    expect(retireSession).not.toContain("Sleep(");
    expect(retireSession).toContain("failRetirementAdmission");
    expect(dllMain).toContain(
      "InterlockedCompareExchange(&g_pendingDaemonRetirements, 0, 0)",
    );
    expect(sessionReady).toContain("inspectContextPrivacy(context, clientId_)");
    expect(sessionReady).toContain(
      "abandonSensitiveSession()",
    );
    expect(abandonSession).toContain("finishAppliedComposition(activeContext_)");
    expect(abandonSession).not.toContain("SetText");
    expect(abandonSession).not.toContain("setSelectionToEnd");
    expect(source).not.toContain("waitForDaemonRetirement");
    expect(source).not.toContain("retirementInFlight_");
    expect(source).toContain("prepareCurrentFocus()");
    expect(source).toContain("prepareFocusedDocument(focus)");
    expect(source).toContain("if (!acceptsKeystrokes_ || !experimentalKeyEatingEnabled() || !context");
    expect(source).toContain("!negotiateDaemon() || !warmDaemon()");
    expect(source).toContain("makeEngineWarmRequest(request)");
    expect(source).toContain(
      "parseEngineWarmResponse(*response, request, serverInstanceId_)",
    );
  });

  it("keeps canonical raw in the TSF range and commits Unicode transactionally", () => {
    const editSession = read("TsfEditSession.cpp");
    expect(editSession).toContain("RequestEditSession");
    expect(editSession).toContain("TF_ES_SYNC | TF_ES_READWRITE");
    expect(editSession).toContain("InsertTextAtSelection");
    expect(editSession).toContain("StartComposition");
    expect(editSession).toContain("GetRange");
    expect(editSession).toContain("SetText");
    expect(editSession).toContain("EndComposition");
    expect(editSession).toContain("EngineDecisionApplication::Applied");
    expect(editSession).toContain(
      "EngineDecisionApplication::AppliedWithOwnershipCleanupRequired",
    );
    expect(editSession).toContain("editSession->completed()");
    expect(editSession).toContain(
      "StartComposition(editCookie, insertedRange, compositionSink_, &composition)",
    );
    expect(editSession).toContain(
      "hr = setSelectionToEnd(context_, editCookie, insertedRange)",
    );
    expect(editSession).toContain(
      "const HRESULT selectionResult = setSelectionToEnd",
    );
    const compose = editSession.slice(
      editSession.indexOf("HRESULT compose(TfEditCookie"),
      editSession.indexOf("HRESULT commit(TfEditCookie"),
    );
    expect(compose).toContain("decision_.compositionText.c_str()");
    expect(compose).not.toContain("decision_.displayText");
    const rejectedCompositionOwnership = compose.slice(
      compose.indexOf("if (FAILED(hr) || !composition)"),
      compose.indexOf("*activeComposition_ = composition"),
    );
    expect(rejectedCompositionOwnership).toContain("insertedRange->Release()");
    expect(rejectedCompositionOwnership).toContain(
      "setSelectionToEnd(context_, editCookie, insertedRange)",
    );
    expect(rejectedCompositionOwnership).not.toContain("SetText");
    expect(rejectedCompositionOwnership).not.toContain("keyEffectApplied_ = false");
    expect(editSession).not.toContain("RestoreRawEditSession");
    expect(editSession).not.toContain("restoreRawAndFinishComposition");
    const finishSession = editSession.slice(
      editSession.indexOf("class FinishEditSession"),
      editSession.indexOf("} // namespace"),
    );
    expect(finishSession).toContain("EndComposition(editCookie)");
    expect(finishSession).not.toContain("SetText");
    expect(finishSession).not.toContain("setSelectionToEnd");
    const cancelSession = editSession.slice(
      editSession.indexOf("HRESULT cancel(TfEditCookie"),
      editSession.indexOf("long refCount_", editSession.indexOf("HRESULT cancel(TfEditCookie")),
    );
    expect(cancelSession).toContain("EndComposition(editCookie)");
    expect(cancelSession).toMatch(
      /if \(SUCCEEDED\(hr\)\) \{\s*keyEffectApplied_ = true;/,
    );
    expect(cancelSession.indexOf("keyEffectApplied_ = true")).toBeGreaterThan(
      cancelSession.indexOf("if (SUCCEEDED(hr))"),
    );
    expect(cancelSession).not.toContain("SetText");
    expect(cancelSession).not.toContain("setSelectionToEnd");
    expect(editSession).toContain("decision_.committedText.c_str()");
  });

  it("suppresses secure, private, PIN, and unclassified contexts", () => {
    const source = read("LekhTextService.cpp");
    const editSession = read("TsfEditSession.cpp");
    const inputScopeGuids = read("InputScopeGuids.cpp");
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
    expect(inputScopeGuids).toContain("<initguid.h>");
    expect(inputScopeGuids).toContain("<inputscope.h>");
    expect(read("CMakeLists.txt")).toContain("InputScopeGuids.cpp");
    const keyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyUp"),
    );
    const privacyTransition = keyDown.slice(
      keyDown.indexOf("if (privacy != lekh::tsf::ContextPrivacy::Safe)"),
      keyDown.indexOf("if (!experimentalKeyEatingEnabled()"),
    );
    expect(privacyTransition).toContain("abandonSensitiveSession()");
    expect(privacyTransition).not.toContain("*eaten = TRUE");
  });

  it("reclassifies reused contexts and conserves every rejected physical key", () => {
    const source = read("LekhTextService.cpp");
    const testKeyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
    );
    const keyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyUp"),
    );
    const rejectedKey = source.slice(
      source.indexOf("bool LekhTextService::handleRejectedKey"),
      source.indexOf("void LekhTextService::closeActiveContext"),
    );

    expect(testKeyDown).toContain("if (activeComposition_ && ownsContext)");
    expect(testKeyDown).toContain("shouldHandleKey(wParam, lParam)");
    expect(testKeyDown.indexOf("activeComposition_")).toBeLessThan(
      testKeyDown.indexOf("experimentalKeyEatingEnabled()"),
    );
    expect(testKeyDown.indexOf("activeComposition_")).toBeLessThan(
      testKeyDown.indexOf("shouldHandleKey(wParam, lParam)"),
    );
    expect(keyDown).toContain("const bool ownsContext = contextIsActive(context)");
    expect(
      keyDown.indexOf("inspectContextPrivacy(context, clientId_)"),
    ).toBeLessThan(keyDown.indexOf("shouldHandleKey(wParam, lParam)"));
    expect(keyDown).toContain(
      "handleRejectedKey(makeKeyEvent(wParam, lParam))",
    );
    expect(rejectedKey).toContain("retireDaemonSession(lekh::tsf::SessionCommand::End)");
    expect(rejectedKey).toContain("finishAppliedComposition(activeContext_)");
    expect(rejectedKey).toContain("releaseActiveComposition(&activeComposition_)");
    expect(rejectedKey).toContain("return false");
    expect(rejectedKey).not.toContain("transitionFallbackForRejectedKey");
    expect(rejectedKey).not.toContain("MessageBeep");
    expect(rejectedKey).not.toContain("ipc_.request");
    expect(source).not.toContain("MessageBeep");
  });

  it("purges sensitive state immediately and never pins lifecycle COM state", () => {
    const source = read("LekhTextService.cpp");
    const abandon = source.slice(
      source.indexOf("LekhTextService::abandonSensitiveSession"),
      source.indexOf("void LekhTextService::quarantineAppliedDaemonSession"),
    );
    const close = source.slice(
      source.indexOf("void LekhTextService::closeActiveContext"),
      source.indexOf(
        "lekh::tsf::RequestMetadata LekhTextService::nextRequestMetadata",
      ),
    );

    expect(abandon.indexOf("compositionText_.clear()")).toBeLessThan(
      abandon.indexOf("finishAppliedComposition(activeContext_)"),
    );
    expect(abandon.indexOf("SessionCommand::End")).toBeLessThan(
      abandon.indexOf("finishAppliedComposition(activeContext_)"),
    );
    expect(abandon).toContain("releaseActiveComposition(&activeComposition_)");
    expect(abandon).not.toContain("SetText");
    expect(abandon).not.toContain("setSelectionToEnd");
    expect(abandon).not.toContain("restoreRawAndFinishComposition");
    expect(source).not.toContain("restoreRawAndFinishComposition");
    expect(source).not.toContain("clearAndFinishSensitiveComposition");
    expect(close).toContain("finishAppliedComposition(activeContext_)");
    expect(close).toContain("releaseActiveComposition(&activeComposition_)");
    expect(close).toContain("releaseActiveContextReferences()");
    expect(close).not.toContain("restoreRawAndFinishComposition");
    expect(close).not.toContain("SetText");
    expect(close).not.toContain("setSelectionToEnd");
    expect(close).not.toContain("pendingRecovery_");
  });

  it("handles host-initiated composition termination without retaining stale ownership", () => {
    const header = read("LekhTextService.h");
    const source = read("LekhTextService.cpp");
    const callback = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnCompositionTerminated"),
      source.indexOf("STDMETHODIMP LekhTextService::OnInitDocumentMgr"),
    );
    const processKey = source.slice(
      source.indexOf("bool LekhTextService::processKey"),
      source.indexOf("void LekhTextService::retireDaemonSession"),
    );

    expect(header).toContain("public ITfCompositionSink");
    expect(header).toContain("OnCompositionTerminated(TfEditCookie editCookie");
    expect(source).toContain("riid == IID_ITfCompositionSink");
    expect(callback).toContain(
      "sameComIdentity(composition, activeComposition_)",
    );
    expect(callback).toContain("releaseActiveComposition(&activeComposition_)");
    expect(callback).toContain("clearDaemonBinding()");
    expect(callback).not.toContain("ipc_.request");
    expect(callback).not.toContain("SetText");
    expect(callback).not.toContain("setSelectionToEnd");
    expect(callback).not.toContain("MessageBeep");
    expect(processKey).toContain(
      "CompositionTerminationDisposition::PreserveAppliedText",
    );
    expect(source).toContain("finishAppliedComposition");
  });

  it("does not consume unsupported candidate or navigation keys without a native UI", () => {
    const source = read("LekhTextService.cpp");
    const handleBlock = source.slice(
      source.indexOf("bool LekhTextService::shouldHandleKey"),
      source.indexOf("bool LekhTextService::experimentalKeyEatingEnabled"),
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
    expect(ipc).toContain(
      "GetOverlappedResult(handle, &overlapped, &ignoredBytes, TRUE)",
    );
    expect(ipc).toContain("lekh::ipc::kMaximumFrameBytes");
    expect(guids).toContain("lekh::ipc::kHotPathDeadlineMilliseconds");
    expect(ipc).toContain("readLineWithDeadline");
    expect(ipc).toContain("writeAllWithDeadline");
    expect(ipc).toContain("if (completedBytes == 0 || completedBytes > requested)");
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
    expect(security).toContain(
      "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    );
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
    const cmake = read("CMakeLists.txt");
    const companion = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(broker).toContain("CreateNamedPipeW");
    expect(broker).toContain("FILE_FLAG_FIRST_PIPE_INSTANCE");
    expect(broker).toContain("PIPE_REJECT_REMOTE_CLIENTS");
    expect(broker).toContain("security.validatePipeHandle(pipe.get())");
    expect(broker).toContain("lekh::ipc::kMaximumActiveConnections");
    expect(broker).toContain("verifyBackendReadiness(backend)");
    expect(broker).toContain("kMaximumConnections - kWorkerCount - 1");
    expect(backend).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(backend).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(backend).toContain("allowedDaemonEnvironmentVariable");
    expect(backend).toContain('L"SystemRoot"');
    expect(backend).toContain('L"LOCALAPPDATA"');
    expect(backend).not.toContain('L"NODE_OPTIONS"');
    expect(backend).not.toContain('L"NODE_PATH"');
    expect(backend).toContain("GetOverlappedResultEx");
    expect(backend).toContain("CREATE_SUSPENDED | CREATE_NO_WINDOW");
    expect(cmake).toContain("add_executable(LekhPipeBroker WIN32");
    expect(cmake).toContain("add_executable(LekhDaemonBackendTests");
    expect(companion).toContain("startWindowsPipeBrokerIfAvailable()");
    expect(companion).toContain("spawn(brokerPath, []");
    expect(companion).toContain("app.requestSingleInstanceLock()");
    expect(companion).toContain('process.argv.includes("--background")');
    expect(companion).toContain('process.platform !== "win32"');
    expect(companion).not.toContain('[daemonPath, "--named-pipe"]');
  });

  it("registers and unregisters owned TSF state with retry-safe architecture routing", () => {
    const registration = read("Register.cpp");
    const installer = readFileSync(
      join(root, "build/installer/windows/installer.nsh"),
      "utf8",
    );
    const registerDev = read("register-dev.ps1");
    const unregisterDev = read("unregister-dev.ps1");
    expect(registration).toContain("RegisterCategory(");
    expect(registration).toContain("UnregisterCategory(");
    expect(registration).toContain("RemoveLanguageProfile(");
    expect(registration).toContain("EnumInputProcessorInfo(&inputProcessors)");
    expect(registration).toContain("inputProcessorRegistrationExists(");
    expect(registration).toContain("languageProfileRegistrationExists(");
    expect(registration).toContain("categoryRegistrationExists(");
    expect(registration).toContain("if (!processorExisted)");
    expect(registration).toContain(
      "const HRESULT comResult = SUCCEEDED(tsfResult) ? unregisterComServer() : S_OK",
    );
    expect(registration).toContain("bool tsfRollbackComplete = true");
    expect(registration).toContain("rollbackTsfRegistration(");
    expect(registration).toContain("rollbackComRegistration(comJournal)");
    expect(registration).toContain("RegistryValueSnapshot");
    expect(registration).toContain("registrySnapshotMatches(value)");
    expect(registration).toContain("processorExists != processorExisted");
    expect(registration).toContain("profileExists != profileExisted");
    expect(registration).toContain("categoryExists != categoryExisted");
    expect(registration).toContain("return FAILED(tsfResult) ? tsfResult : comResult");
    expect(registration).toContain("inspectComRegistration(");
    expect(registration).toContain("validateComUnregistrationOwnership()");
    expect(registration).toContain("ERROR_NOT_OWNER");
    expect(registration).toContain("RegistrationMutex registrationMutex");
    expect(registration).toContain("WaitForSingleObject(handle_, 30'000)");
    expect(registration).toContain("initializeResult != RPC_E_CHANGED_MODE");
    expect(installer).toContain("lekh_tsf_unregistration_failed");
    expect(installer).toContain("preserving the complete installation for a safe retry");
    expect(installer).toContain("lekh_startup_slot_conflict");
    expect(installer).toContain("$WINDIR\\Sysnative\\regsvr32.exe");
    expect(installer).toContain("$WINDIR\\SysWOW64\\regsvr32.exe");
    expect(installer).toContain("build-Win32\\bin\\Release\\LekhTextService.dll");
    const installMacro = installer.slice(
      installer.indexOf("!macro customInstall"),
      installer.indexOf("!macro customUnInstall"),
    );
    expect(installMacro).not.toContain("regsvr32.exe /u");
    expect(installer).toContain("--background");
    expect(registerDev).toContain("$LASTEXITCODE -ne 0");
    expect(registerDev).toContain("TSF registration failed");
    expect(unregisterDev).toContain("$LASTEXITCODE -ne 0");
    expect(unregisterDev).toContain("A registered TSF DLL or architecture-specific system registration tool is missing");
  });

  it("exports every COM and regsvr32 entry point and exercises the built class factory", () => {
    const cmake = read("CMakeLists.txt");
    const exports = read("LekhTextService.def");
    const exportTest = read("LekhComExportTests.cpp");
    for (const entryPoint of [
      "DllCanUnloadNow",
      "DllGetClassObject",
      "DllRegisterServer",
      "DllUnregisterServer",
    ]) {
      expect(exports).toMatch(new RegExp(`^\\s*${entryPoint}\\s*$`, "m"));
      expect(exportTest).toContain(`"${entryPoint}"`);
    }
    expect(cmake).toContain("LekhTextService.def");
    expect(cmake).toContain("add_executable(LekhComExportTests");
    expect(cmake).toContain("COMMAND LekhComExportTests \"$<TARGET_FILE:LekhTextService>\"");
    expect(exportTest).toContain("GetProcAddress(module, exportName)");
    expect(exportTest).toContain("CLSID_LekhTextService");
    expect(exportTest).toContain("IID_IClassFactory");
  });

  it("uses COM identity and ignores background document-stack callbacks", () => {
    const source = read("LekhTextService.cpp");
    const testKeyDown = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnTestKeyDown"),
      source.indexOf("STDMETHODIMP LekhTextService::OnKeyDown"),
    );
    const push = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnPushContext"),
      source.indexOf("STDMETHODIMP LekhTextService::OnPopContext"),
    );
    const pop = source.slice(
      source.indexOf("STDMETHODIMP LekhTextService::OnPopContext"),
      source.indexOf("bool LekhTextService::shouldHandleKey"),
    );
    expect(testKeyDown).not.toContain("prepareSafeContext");
    expect(testKeyDown).not.toContain("recoverAbandonedContextForKey");
    expect(source).toContain("QueryInterface(IID_IUnknown");
    expect(source).toContain("contextIsActive(context)");
    expect(source).not.toMatch(/context\s*[!=]=\s*activeContext_/);
    expect(source).not.toMatch(/activeContext_\s*[!=]=\s*context/);
    expect(push).toContain("threadMgr_->GetFocus(&focusedDocument)");
    expect(push).toContain("focusedDocument->GetTop(&focusedTop)");
    expect(push).toContain("sameComIdentity(context, focusedTop)");
    expect(pop).toContain("if (!contextIsActive(context)) return S_OK");
    expect(pop).not.toContain("documentManagerIsCurrentFocus(activeDocumentManager_)");
  });

  it.skipIf(process.platform === "win32")(
    "compiles and runs the portable native protocol tests",
    () => {
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "lekh-tsf-protocol-"),
      );
      temporaryDirectories.push(temporaryDirectory);
      const executable = join(temporaryDirectory, "TsfProtocolTests");
      const build = spawnSync(
        "c++",
        [
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Wpedantic",
          "-Werror",
          join(skeleton, "TsfProtocol.cpp"),
          join(skeleton, "TsfProtocolTests.cpp"),
          "-o",
          executable,
        ],
        { encoding: "utf8" },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const run = spawnSync(executable, [], { encoding: "utf8" });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain("TSF protocol v2 tests passed");

      const recoveryExecutable = join(
        temporaryDirectory,
        "CompositionRecoveryTests",
      );
      const recoveryBuild = spawnSync(
        "c++",
        [
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Wpedantic",
          "-Werror",
          join(skeleton, "CompositionRecoveryTests.cpp"),
          "-o",
          recoveryExecutable,
        ],
        { encoding: "utf8" },
      );
      expect(
        recoveryBuild.status,
        `${recoveryBuild.stdout}\n${recoveryBuild.stderr}`,
      ).toBe(0);

      const recoveryRun = spawnSync(recoveryExecutable, [], {
        encoding: "utf8",
      });
      expect(
        recoveryRun.status,
        `${recoveryRun.stdout}\n${recoveryRun.stderr}`,
      ).toBe(0);
      expect(recoveryRun.stdout).toContain(
        "TSF composition recovery tests passed",
      );

      const retirementExecutable = join(
        temporaryDirectory,
        "DaemonRetirementTests",
      );
      const retirementBuild = spawnSync(
        "c++",
        [
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Wpedantic",
          "-Werror",
          join(skeleton, "DaemonRetirementTests.cpp"),
          "-o",
          retirementExecutable,
        ],
        { encoding: "utf8" },
      );
      expect(
        retirementBuild.status,
        `${retirementBuild.stdout}\n${retirementBuild.stderr}`,
      ).toBe(0);
      const retirementRun = spawnSync(retirementExecutable, [], {
        encoding: "utf8",
      });
      expect(
        retirementRun.status,
        `${retirementRun.stdout}\n${retirementRun.stderr}`,
      ).toBe(0);
      expect(retirementRun.stdout).toContain(
        "TSF daemon retirement tests passed",
      );
    },
  );
});

function read(file: string): string {
  return readFileSync(join(skeleton, file), "utf8");
}
