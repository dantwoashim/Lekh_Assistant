import Foundation

struct CompanionCopy {
  let locale: CompanionLocale

  private func value(_ english: String, _ nepali: String) -> String {
    locale == .english ? english : nepali
  }

  var appName: String { "Lekh Keyboard" }
  var companion: String { value("Companion", "साथी") }
  var settingsCommand: String { value("Lekh Keyboard Settings…", "Lekh Keyboard सेटिङ…") }
  var home: String { value("Home", "गृह") }
  var typing: String { value("Typing", "टाइपिङ") }
  var privacy: String { value("Privacy", "गोपनीयता") }
  var diagnostics: String { value("Diagnostics", "डायग्नोस्टिक्स") }
  var language: String { value("Language", "भाषा") }
  var refresh: String { value("Refresh status", "स्थिति रिफ्रेस गर्नुहोस्") }
  var saved: String { value("Saved. New words use this setting immediately.", "सेभ भयो। नयाँ शब्दमा यो सेटिङ तुरुन्त लागू हुन्छ।") }
  var returnToRefresh: String { value("Return here after changing Keyboard Settings; Lekh will refresh automatically.", "Keyboard Settings बदलेपछि यहाँ फर्कनुहोस्; Lekh स्वतः रिफ्रेस हुन्छ।") }
  var keyboardActivated: String { value("macOS selected Lekh. Open a text field to verify that its engine connects; Control–Space returns to your previous source.", "macOS ले Lekh चयन गर्‍यो। यसको इन्जिन जोडिएको पुष्टि गर्न टेक्स्ट फिल्ड खोल्नुहोस्; Control–Space ले अघिल्लो स्रोतमा फर्काउँछ।") }
  var activationFailed: String { value("macOS could not activate Lekh directly. Keyboard Settings is open so you can select it manually.", "macOS ले Lekh सीधै सक्रिय गर्न सकेन। म्यानुअल रूपमा छान्न Keyboard Settings खोलिएको छ।") }
  var registrationSucceeded: String { value("Lekh was registered with macOS. The setup status will refresh now.", "Lekh macOS मा दर्ता भयो। सेटअप स्थिति अब रिफ्रेस हुन्छ।") }
  var registrationFailed: String { value("macOS could not register this keyboard bundle. Keyboard Settings is open for recovery.", "macOS ले यो किबोर्ड bundle दर्ता गर्न सकेन। समाधानका लागि Keyboard Settings खोलिएको छ।") }
  var registrationBundleInvalid: String { value("The installed Lekh bundle failed identity or signature validation. Replace it before registration.", "इन्स्टल भएको Lekh bundle को पहिचान वा हस्ताक्षर प्रमाणीकरण असफल भयो। दर्ता गर्नुअघि यसलाई बदल्नुहोस्।") }
  var diagnosticsCopied: String { value("Diagnostics copied without typed text.", "टाइप गरिएको पाठबिना डायग्नोस्टिक्स कपी भयो।") }
  var learningCleared: String { value("Personal learning was cleared from this Mac.", "व्यक्तिगत सिकाइ यो Mac बाट हटाइयो।") }
  var learningClearFailed: String { value("Personal learning could not be cleared. Quit apps using Lekh and try again.", "व्यक्तिगत सिकाइ हटाउन सकिएन। Lekh चलाइरहेका एप बन्द गरेर फेरि प्रयास गर्नुहोस्।") }
  var exclusionsSaved: String { value("Private-app exclusions were saved locally.", "निजी-एप बहिष्करण स्थानीय रूपमा सेभ भयो।") }

  var welcomeTitle: String { value("Write Nepali without breaking your flow.", "आफ्नो लय नतोडी नेपाली लेख्नुहोस्।") }
  var welcomeBody: String { value("Lekh works in the app where you are already writing. This companion only handles setup, preferences, privacy and diagnostics.", "Lekh तपाईंले लेखिरहनुभएको एपमै चल्छ। यो साथी एपले सेटअप, प्राथमिकता, गोपनीयता र डायग्नोस्टिक्स मात्र सम्हाल्छ।") }
  var installed: String { value("Installed", "इन्स्टल भयो") }
  var added: String { value("Added to input sources", "इनपुट स्रोतमा थपियो") }
  var active: String { value("Active now", "अहिले सक्रिय") }
  var missingTitle: String { value("Install Lekh Keyboard", "Lekh Keyboard इन्स्टल गर्नुहोस्") }
  var missingBody: String { value("The native input method is not present in your Input Methods folder.", "नेटिभ इनपुट मेथड तपाईंको Input Methods फोल्डरमा छैन।") }
  var addTitle: String { value("Add Lekh once", "Lekh एकपटक थप्नुहोस्") }
  var addBody: String { value("Open Keyboard Settings, edit Input Sources, then add Lekh Keyboard under Nepali.", "Keyboard Settings खोल्नुहोस्, Input Sources सम्पादन गर्नुहोस्, अनि नेपालीअन्तर्गत Lekh Keyboard थप्नुहोस्।") }
  var approvalTitle: String { value("Enable Lekh in macOS", "macOS मा Lekh सक्षम गर्नुहोस्") }
  var approvalBody: String { value("The input source is registered, but macOS reports it disabled. Enable Lekh in Keyboard Settings and approve any system prompt.", "इनपुट स्रोत दर्ता छ, तर macOS ले यसलाई बन्द देखाउँछ। Keyboard Settings मा Lekh सक्षम गरेर प्रणालीको अनुरोध स्वीकार्नुहोस्।") }
  var readyTitle: String { value("Ready whenever you need it", "चाहिएको बेला तयार") }
  var readyBody: String { value("Choose Lekh from the menu bar or press Control–Space. ABC stays available as a safe fallback.", "मेनु बारबाट Lekh छान्नुहोस् वा Control–Space थिच्नुहोस्। सुरक्षित विकल्पका रूपमा ABC उपलब्ध रहन्छ।") }
  var activeTitle: String { value("Lekh is active", "Lekh सक्रिय छ") }
  var activeBody: String { value("Start typing in TextEdit, Notes, Safari or any regular text field.", "TextEdit, Notes, Safari वा कुनै सामान्य टेक्स्ट फिल्डमा टाइप गर्न सुरु गर्नुहोस्।") }
  var selectedUnverifiedTitle: String { value("Selected · waiting for a typing check", "चयनित · टाइपिङ जाँचको प्रतीक्षामा") }
  var selectedUnverifiedBody: String { value("Lekh is selected, but macOS has not connected a text field to its engine yet. Try it in TextEdit, then refresh.", "Lekh चयनित छ, तर macOS ले अझै टेक्स्ट फिल्डलाई यसको इन्जिनसँग जोडेको छैन। TextEdit मा प्रयास गरेर रिफ्रेस गर्नुहोस्।") }
  var notRespondingTitle: String { value("Selected but not responding", "चयनित छ तर प्रतिक्रिया दिइरहेको छैन") }
  var notRespondingBody: String { value("The selected input source does not have a matching live server and controller. ABC remains available while you repair Lekh.", "चयनित इनपुट स्रोतसँग मिल्ने चलिरहेको सर्भर र कन्ट्रोलर छैन। Lekh मर्मत गर्दा ABC उपलब्ध रहन्छ।") }
  var workingTitle: String { value("Lekh is working", "Lekh काम गरिरहेको छ") }
  var workingBody: String { value("A live, build-matched input-method controller has connected successfully on this Mac.", "यो Mac मा चलिरहेको, यही build सँग मिल्ने इनपुट-मिथड कन्ट्रोलर सफलतापूर्वक जोडिएको छ।") }
  var openKeyboardSettings: String { value("Open Keyboard Settings", "Keyboard Settings खोल्नुहोस्") }
  var enableLekh: String { value("Enable Lekh", "Lekh सक्षम गर्नुहोस्") }
  var useLekhNow: String { value("Use Lekh Now", "अहिले Lekh प्रयोग गर्नुहोस्") }
  var tryTextEdit: String { value("Try in TextEdit", "TextEdit मा प्रयास गर्नुहोस्") }
  var revealInstallation: String { value("Reveal installation", "इन्स्टलेशन देखाउनुहोस्") }
  var setupProgress: String { value("Setup", "सेटअप") }
  var registered: String { value("Registered", "दर्ता") }
  var enabledInMacOS: String { value("Enabled", "सक्षम") }
  var selectedNow: String { value("Selected", "चयनित") }
  var engineConnected: String { value("Engine verified", "इन्जिन प्रमाणित") }
  var setupComplete: String { value("Complete", "पूरा") }
  var setupIncomplete: String { value("Incomplete", "अपूर्ण") }
  var setupNeedsAttention: String { value("Needs attention", "ध्यान चाहिन्छ") }
  var version: String { value("Version", "संस्करण") }

  func statusTitle(_ readiness: KeyboardReadiness) -> String {
    switch readiness {
    case .missing: return missingTitle
    case .installedUnregistered: return addTitle
    case .approvalRequired: return approvalTitle
    case .enabledNotSelected: return readyTitle
    case .selectedUntested: return selectedUnverifiedTitle
    case .healthy: return workingTitle
    case .degraded: return notRespondingTitle
    }
  }

  func statusBody(_ readiness: KeyboardReadiness) -> String {
    switch readiness {
    case .missing: return missingBody
    case .installedUnregistered: return addBody
    case .approvalRequired: return approvalBody
    case .enabledNotSelected: return readyBody
    case .selectedUntested: return selectedUnverifiedBody
    case .healthy: return workingBody
    case .degraded(let failure): return degradedBody(failure)
    }
  }

  func primaryActionTitle(_ action: KeyboardPrimaryAction) -> String {
    switch action {
    case .showInstallLocation: return value("Open Input Methods Folder", "Input Methods फोल्डर खोल्नुहोस्")
    case .register: return value("Add in Keyboard Settings", "Keyboard Settings मा थप्नुहोस्")
    case .enable: return value("Enable in Keyboard Settings", "Keyboard Settings मा सक्षम गर्नुहोस्")
    case .select: return useLekhNow
    case .verify: return value("Verify in TextEdit", "TextEdit मा प्रमाणित गर्नुहोस्")
    case .write: return value("Start Writing", "लेख्न सुरु गर्नुहोस्")
    case .reconnect: return value("Reconnect in TextEdit", "TextEdit मा पुनः जडान गर्नुहोस्")
    case .replaceBuild: return value("Reveal Installed Build", "इन्स्टल भएको build देखाउनुहोस्")
    }
  }

  func recoveryTitle(_ plan: KeyboardRecoveryPlan) -> String {
    switch plan {
    case .ready: return value("Connection verified", "जडान प्रमाणित")
    case .replaceBuild: return value("Replace the stale build", "पुरानो build बदल्नुहोस्")
    case .reconnect: return value("Reconnect the engine", "इन्जिन पुनः जडान गर्नुहोस्")
    default: return value("Finish setup", "सेटअप पूरा गर्नुहोस्")
    }
  }

  func recoveryStep(index: Int, total: Int, text: String) -> String {
    value(
      "Step \(index) of \(total). \(text)",
      "चरण \(index), जम्मा \(total)। \(text)"
    )
  }

  func recoverySteps(_ plan: KeyboardRecoveryPlan) -> [String] {
    switch plan {
    case .install:
      return localizedSteps(
        english: [
          "Place Lekh Keyboard.app in ~/Library/Input Methods.",
          "Sign out and back in so macOS can register the input method."
        ],
        nepali: [
          "Lekh Keyboard.app लाई ~/Library/Input Methods मा राख्नुहोस्।",
          "macOS ले इनपुट मेथड दर्ता गर्न sign out गरेर फेरि sign in गर्नुहोस्।"
        ]
      )
    case .register:
      return localizedSteps(
        english: [
          "Open Keyboard Settings, then open Text Input → Edit.",
          "Add Lekh Keyboard under Nepali and return here."
        ],
        nepali: [
          "Keyboard Settings खोलेर Text Input → Edit खोल्नुहोस्।",
          "नेपालीअन्तर्गत Lekh Keyboard थपेर यहाँ फर्कनुहोस्।"
        ]
      )
    case .enable:
      return localizedSteps(
        english: [
          "Enable the registered Lekh source in Keyboard Settings.",
          "Approve any macOS prompt, then return here for an automatic refresh."
        ],
        nepali: [
          "Keyboard Settings मा दर्ता भएको Lekh स्रोत सक्षम गर्नुहोस्।",
          "macOS को अनुरोध स्वीकारेर स्वतः रिफ्रेसका लागि यहाँ फर्कनुहोस्।"
        ]
      )
    case .select:
      return localizedSteps(
        english: [
          "Select Lekh now or choose it from the menu-bar Input menu.",
          "Keep ABC available; Control–Space switches back safely."
        ],
        nepali: [
          "अहिले Lekh चयन गर्नुहोस् वा मेनु बारको Input मेनुबाट छान्नुहोस्।",
          "ABC उपलब्ध राख्नुहोस्; Control–Space ले सुरक्षित रूपमा फर्काउँछ।"
        ]
      )
    case .verify:
      return localizedSteps(
        english: [
          "Open TextEdit and click a new plain-text document.",
          "Type namaste, then return here; the live controller should become verified."
        ],
        nepali: [
          "TextEdit खोलेर नयाँ plain-text document मा क्लिक गर्नुहोस्।",
          "namaste टाइप गरेर यहाँ फर्कनुहोस्; चलिरहेको कन्ट्रोलर प्रमाणित हुनुपर्छ।"
        ]
      )
    case .ready:
      return localizedSteps(
        english: [
          "The selected source, live controller and installed build match.",
          "Write in any regular text field; macOS handles secure fields with its safe fallback."
        ],
        nepali: [
          "चयनित स्रोत, चलिरहेको कन्ट्रोलर र इन्स्टल भएको build मिल्छन्।",
          "सामान्य टेक्स्ट फिल्डमा लेख्नुहोस्; सुरक्षित फिल्ड macOS ले सुरक्षित fallback बाट सम्हाल्छ।"
        ]
      )
    case .reconnect:
      return localizedSteps(
        english: [
          "Open TextEdit to give the selected source a fresh text client.",
          "If it remains disconnected, switch to ABC and back to Lekh from the Input menu.",
          "Return here; connection status refreshes automatically."
        ],
        nepali: [
          "चयनित स्रोतलाई नयाँ text client दिन TextEdit खोल्नुहोस्।",
          "जडान नभए Input मेनुबाट ABC मा गएर फेरि Lekh छान्नुहोस्।",
          "यहाँ फर्कनुहोस्; जडान स्थिति स्वतः रिफ्रेस हुन्छ।"
        ]
      )
    case .replaceBuild:
      return localizedSteps(
        english: [
          "Quit apps using Lekh and reveal the installed keyboard bundle.",
          "Replace it with the intended build and remove duplicate Lekh bundles.",
          "Sign out and back in, select Lekh, then verify it in TextEdit."
        ],
        nepali: [
          "Lekh चलाइरहेका एप बन्द गरेर इन्स्टल भएको keyboard bundle देखाउनुहोस्।",
          "सही build ले बदल्नुहोस् र दोहोरिएका Lekh bundle हटाउनुहोस्।",
          "Sign out गरेर फेरि sign in गर्नुहोस्, Lekh छानेर TextEdit मा प्रमाणित गर्नुहोस्।"
        ]
      )
    }
  }

  private func degradedBody(_ failure: KeyboardFailure) -> String {
    switch failure {
    case .wrongBuild:
      return value("The live input-method process belongs to a different build than the installed keyboard bundle.", "चलिरहेको इनपुट-मिथड प्रक्रिया इन्स्टल भएको keyboard bundle भन्दा फरक build को हो।")
    case .wrongBundle:
      return value("The runtime health record belongs to a different input-method bundle.", "रनटाइम स्वास्थ्य रेकर्ड फरक इनपुट-मिथड bundle को हो।")
    case .wrongSchema, .unreadableHealth:
      return value("Lekh is selected, but its runtime health record cannot be verified safely.", "Lekh चयनित छ, तर यसको रनटाइम स्वास्थ्य रेकर्ड सुरक्षित रूपमा प्रमाणित हुन सकेन।")
    case .wrongConnection, .controllerMissing:
      return value("Lekh is selected, but its server and text-input controller have not completed a valid connection.", "Lekh चयनित छ, तर यसको सर्भर र text-input controller को मान्य जडान पूरा भएको छैन।")
    case .processExited:
      return value("Lekh is selected, but the last verified input-method process is no longer running.", "Lekh चयनित छ, तर पछिल्लो प्रमाणित इनपुट-मिथड प्रक्रिया अब चलिरहेको छैन।")
    }
  }

  private func localizedSteps(english: [String], nepali: [String]) -> [String] {
    locale == .english ? english : nepali
  }

  var ghostTitle: String { value("A quiet suggestion, never a surprise", "शान्त सुझाव, कहिल्यै अनपेक्षित होइन") }
  var ghostBody: String { value("A high-confidence completion appears in gray. Tab or → accepts it. Keep typing to ignore it. Space converts only a verified safe exact mapping; otherwise it preserves your raw input.", "उच्च विश्वासको पूर्णता खैरोमा देखिन्छ। Tab वा → ले स्वीकार्छ। बेवास्ता गर्न टाइप गरिरहनुहोस्। Space ले प्रमाणित सुरक्षित मिलान मात्र रूपान्तरण गर्छ; अन्यथा टाइप गरेकै अक्षर राख्छ।") }
  var ghostVerifiedStatus: String { value("Real ghost rendering verified", "वास्तविक खैरो सुझाव देखिएको प्रमाणित") }
  var ghostAwaitingEvidenceStatus: String { value("Keyboard connected · no ghost shown yet", "किबोर्ड जोडिएको छ · खैरो सुझाव अझै देखिएको छैन") }
  var ghostSelectedUntestedStatus: String { value("Illustration only · verify it in TextEdit", "उदाहरण मात्र · TextEdit मा प्रमाणित गर्नुहोस्") }
  var ghostInactiveStatus: String { value("Illustration only · activate Lekh to use it", "उदाहरण मात्र · प्रयोग गर्न Lekh सक्रिय गर्नुहोस्") }
  var ghostDegradedStatus: String { value("Illustration only · the keyboard is not responding", "उदाहरण मात्र · किबोर्डले प्रतिक्रिया दिइरहेको छैन") }
  var ghostDisabledStatus: String { value("Ghost suggestions are off", "खैरो सुझाव बन्द छ") }
  var ghostVerifiedOfferedEvidence: String {
    value(
      "Lekh recently showed a real gray completion. The example below is only a guide.",
      "Lekh ले हालै वास्तविक खैरो पूर्णता देखायो। तलको उदाहरण प्रयोग विधि मात्र हो।"
    )
  }
  var ghostVerifiedAcceptedEvidence: String {
    value(
      "Lekh recently showed a real gray completion, and Tab or → was used. The example below is only a guide.",
      "Lekh ले हालै वास्तविक खैरो पूर्णता देखायो र Tab वा → प्रयोग भयो। तलको उदाहरण प्रयोग विधि मात्र हो।"
    )
  }
  func ghostAwaitingEvidenceDetail(suppressionCount: Int) -> String {
    if suppressionCount > 0 {
      return value(
        "No completion appeared during the most recent verified activation. Lekh recorded \(suppressionCount) content-free eligibility, dismissal or presentation events. This diagnostic evidence contains no typed or candidate text.",
        "पछिल्लो प्रमाणित सक्रियतामा कुनै पूर्णता देखिएन। Lekh ले \(suppressionCount) वटा पाठरहित योग्यता, हटाउने वा प्रस्तुति घटना रेकर्ड गर्‍यो। यो डायग्नोस्टिक प्रमाणमा टाइप वा उम्मेदवार पाठ छैन।"
      )
    }
    return value(
      "Type a supported word in TextEdit to collect real on-screen evidence. A running controller alone does not verify this feature.",
      "वास्तविक अन-स्क्रिन प्रमाणका लागि TextEdit मा समर्थित शब्द टाइप गर्नुहोस्। किबोर्ड इन्जिन चल्नु मात्रले यो सुविधा प्रमाणित गर्दैन।"
    )
  }
  var ghostIllustrationOnlyEvidence: String {
    value(
      "This sample explains the interaction; it is not evidence that the installed keyboard displayed a completion.",
      "यो नमुनाले प्रयोग विधि बुझाउँछ; इन्स्टल भएको किबोर्डले पूर्णता देखाएको प्रमाण होइन।"
    )
  }
  var ghostDisabledEvidence: String {
    value(
      "No new inline completions are displayed while this setting is off.",
      "यो सेटिङ बन्द हुँदा नयाँ इनलाइन पूर्णता देखाइँदैन।"
    )
  }
  var ghostConfidenceNote: String { value("Lekh shows this only when it has a confident token-level completion; nothing is inserted until you accept it.", "Lekh सँग भरपर्दो टोकन-स्तरको पूर्णता हुँदा मात्र यो देखिन्छ; तपाईंले स्वीकार नगरेसम्म केही पनि घुसाइँदैन।") }
  var enableGhostSuggestions: String { value("Turn On Ghost Suggestions", "खैरो सुझाव खोल्नुहोस्") }
  func ghostModeExample(_ mode: NativeTypingMode) -> String {
    value("Illustration for \(modeName(mode))", "\(modeName(mode)) को उदाहरण")
  }
  func ghostPreviewAccessibility(typed: String, suggestion: String) -> String {
    value(
      "Example. Composed text: \(typed). Gray suggested completion: \(suggestion).",
      "उदाहरण। लेखिएको पाठ: \(typed)। खैरो सुझाइएको पूर्णता: \(suggestion)।"
    )
  }
  var ghostAcceptanceAccessibility: String {
    value(
      "Press Tab or Right Arrow to accept the visible completion, or keep typing to ignore it.",
      "देखिएको पूर्णता स्वीकार्न Tab वा दायाँ एरो थिच्नुहोस्, वा बेवास्ता गर्न टाइप गरिरहनुहोस्।"
    )
  }
  func ghostStatusAccessibility(status: String, evidence: String) -> String {
    value(
      "Ghost suggestion status: \(status). Evidence: \(evidence)",
      "खैरो सुझाव स्थिति: \(status)। प्रमाण: \(evidence)"
    )
  }
  var accept: String { value("accept", "स्वीकार") }
  var ignore: String { value("or keep typing to ignore", "वा बेवास्ता गर्न टाइप गरिरहनुहोस्") }

  var typingTitle: String { value("Make Lekh feel like your keyboard", "Lekh लाई आफ्नै किबोर्डजस्तो बनाउनुहोस्") }
  var typingBody: String { value("Choose the input and output scripts you actually use. Lekh keeps every mode distinct.", "तपाईंले प्रयोग गर्ने इनपुट र आउटपुट लिपि छान्नुहोस्। Lekh ले हरेक मोडलाई अलग राख्छ।") }
  var modeTitle: String { value("Typing mode", "टाइपिङ मोड") }
  var modeHint: String { value("Changes apply at the next word boundary so an active composition is never corrupted.", "परिवर्तन अर्को शब्दबाट लागू हुन्छ, त्यसैले लेखिँदै गरेको शब्द बिग्रँदैन।") }
  var recommended: String { value("Recommended", "सिफारिस गरिएको") }
  func modeName(_ mode: NativeTypingMode) -> String {
    switch mode {
    case .romanizedNepali: return value("Roman letters → Nepali · Recommended", "रोमन अक्षर → नेपाली · सिफारिस")
    case .romanizedRomanized: return value("Roman letters → Roman text", "रोमन अक्षर → रोमन पाठ")
    case .traditionalNepali: return value("Traditional layout → Nepali", "परम्परागत लेआउट → नेपाली")
    case .traditionalRomanized: return value("Traditional layout → Roman text", "परम्परागत लेआउट → रोमन पाठ")
    }
  }
  func modeDetail(_ mode: NativeTypingMode) -> String {
    switch mode {
    case .romanizedNepali: return value("Type namaste, get नमस्ते", "namaste टाइप गर्नुहोस्, नमस्ते पाउनुहोस्")
    case .romanizedRomanized: return value("Keep Latin output with spelling assistance", "हिज्जे सहायतासहित ल्याटिन आउटपुट राख्नुहोस्")
    case .traditionalNepali: return value("Use the traditional key layout in Devanagari", "देवनागरीमा परम्परागत की लेआउट प्रयोग गर्नुहोस्")
    case .traditionalRomanized: return value("Read traditional input in Roman letters", "परम्परागत इनपुट रोमन अक्षरमा पढ्नुहोस्")
    }
  }
  var assistance: String { value("Assistance", "सहायता") }
  var ghostSuggestions: String { value("Ghost suggestions", "खैरो सुझाव") }
  var ghostSuggestionsDetail: String { value("Show one conservative inline completion.", "एउटा भरपर्दो खैरो पूर्णता देखाउनुहोस्।") }
  var candidateList: String { value("Alternate candidates", "वैकल्पिक शब्द") }
  var candidateListDetail: String { value("Show legitimate spelling or transliteration alternatives.", "उपयुक्त हिज्जे वा लिप्यन्तरणका विकल्प देखाउनुहोस्।") }
  var proofread: String { value("Traditional spelling help", "परम्परागत हिज्जे सहायता") }
  var proofreadDetail: String { value("Offer local corrections for Devanagari input.", "देवनागरी इनपुटका लागि स्थानीय सुधार दिनुहोस्।") }
  var punctuation: String { value("Nepali punctuation", "नेपाली विरामचिह्न") }
  var punctuationDetail: String { value("Use danda naturally in Nepali output modes.", "नेपाली आउटपुट मोडमा डण्डा स्वाभाविक रूपमा प्रयोग गर्नुहोस्।") }
  func assistanceDetail(_ mode: NativeTypingMode) -> String {
    switch mode {
    case .romanizedNepali:
      return value(
        "Inline completions, alternate words and Nepali punctuation apply to this mode.",
        "यो मोडमा इनलाइन पूर्णता, वैकल्पिक शब्द र नेपाली विरामचिह्न लागू हुन्छन्।"
      )
    case .romanizedRomanized:
      return value(
        "Inline completions and alternate Roman spellings apply. Nepali punctuation and Devanagari proofreading do not change Roman output.",
        "इनलाइन पूर्णता र वैकल्पिक रोमन हिज्जे लागू हुन्छन्। नेपाली विरामचिह्न र देवनागरी हिज्जे सुधारले रोमन आउटपुट बदल्दैनन्।"
      )
    case .traditionalNepali:
      return value(
        "Inline completions, alternate words, Devanagari spelling help and Nepali punctuation apply to this mode.",
        "यो मोडमा इनलाइन पूर्णता, वैकल्पिक शब्द, देवनागरी हिज्जे सहायता र नेपाली विरामचिह्न लागू हुन्छन्।"
      )
    case .traditionalRomanized:
      return value(
        "Inline completions, alternate Roman readings and Devanagari spelling help apply. Nepali punctuation does not change Roman output.",
        "इनलाइन पूर्णता, वैकल्पिक रोमन पठन र देवनागरी हिज्जे सहायता लागू हुन्छन्। नेपाली विरामचिह्नले रोमन आउटपुट बदल्दैन।"
      )
    }
  }
  var shortcuts: String { value("While composing", "टाइप गरिरहँदा") }
  var shortcutAccept: String { value("Accept the gray completion", "खैरो पूर्णता स्वीकार्नुहोस्") }
  var shortcutAlternates: String { value("Explore alternate candidates", "वैकल्पिक शब्द हेर्नुहोस्") }
  var shortcutRaw: String { value("Safe exact mapping, otherwise raw", "सुरक्षित ठ्याक्कै मिलान, अन्यथा टाइप गरेकै अक्षर") }
  var shortcutDismiss: String { value("Dismiss suggestions safely", "सुझाव सुरक्षित रूपमा हटाउनुहोस्") }
  func shortcutAccessibility(keys: [String], action: String) -> String {
    let separator = value(" or ", " वा ")
    let spokenKeys = keys.map(spokenKey).joined(separator: separator)
    return "\(spokenKeys): \(action)"
  }

  private func spokenKey(_ key: String) -> String {
    switch key {
    case "Tab": return value("Tab key", "Tab की")
    case "→": return value("Right Arrow", "दायाँ एरो")
    case "↓": return value("Down Arrow", "तल एरो")
    case "↑": return value("Up Arrow", "माथि एरो")
    case "Space": return value("Space bar", "Space बार")
    case "Esc": return value("Escape key", "Escape की")
    default: return key
    }
  }

  var privacyTitle: String { value("Your writing stays yours", "तपाईंको लेखाइ तपाईंकै रहन्छ") }
  var privacyBody: String { value("Typing uses the local native engine. The companion never receives per-keystroke text.", "टाइप गर्दा स्थानीय नेटिभ इन्जिन चल्छ। सहायक एपले हरेक कीसँगै लेखिएको पाठ पाउँदैन।") }
  var localOnly: String { value("Local by default", "पूर्वनिर्धारित रूपमा स्थानीय") }
  var localOnlyDetail: String { value("No network or companion IPC is needed while typing.", "टाइप गर्दा नेटवर्क वा सहायक एपसँग सम्पर्क चाहिँदैन।") }
  var secureFields: String { value("Secure input is always bypassed", "सुरक्षित इनपुट सधैं बाइपास हुन्छ") }
  var secureFieldsDetail: String { value("When macOS marks a field secure: no suggestions, inference, learning, diagnostics or retention.", "macOS ले फिल्ड सुरक्षित मानेपछि सुझाव, मोडेल, सिकाइ, अभिलेख वा भण्डारण चल्दैन।") }
  var explicitLearning: String { value("Learning follows your choices", "सिकाइ तपाईंको छनोटअनुसार") }
  var explicitLearningDetail: String { value("Only explicitly accepted words can affect local ranking.", "स्पष्ट रूपमा स्वीकारिएका शब्दले मात्र स्थानीय ranking असर गर्छन्।") }
  var personalLearning: String { value("Personal learning", "व्यक्तिगत सिकाइ") }
  var personalLearningDetail: String { value("Improve ranking from candidates you explicitly accept.", "तपाईंले स्वीकारेका शब्दका आधारमा विकल्पको क्रम सुधार्नुहोस्।") }
  var contextRanking: String { value("Context-aware ranking", "सन्दर्भअनुसार क्रम") }
  var contextRankingDetail: String { value("Use the previous committed word locally to order candidates.", "विकल्पको क्रम मिलाउन अघिल्लो लेखिएको शब्द स्थानीय रूपमा प्रयोग गर्नुहोस्।") }
  var learnedWords: String { value("Learned choices", "सिकेका छनोट") }
  func learnedCount(_ count: Int) -> String {
    if locale == .english {
      return count == 1 ? "1 local entry" : "\(count) local entries"
    }
    return "\(count) स्थानीय छनोट"
  }
  var clearLearning: String { value("Clear Personal Learning…", "व्यक्तिगत सिकाइ हटाउनुहोस्…") }
  var clearingLearning: String { value("Clearing personal learning", "व्यक्तिगत सिकाइ हटाइँदै छ") }
  var clearLearningTitle: String { value("Clear all personal learning?", "सबै व्यक्तिगत सिकाइ हटाउने?") }
  var clearLearningBody: String { value("This removes learned words and context counts from this Mac. It cannot be undone.", "यसले यो Mac बाट सिकेका शब्द र सन्दर्भ गणना हटाउँछ। यो उल्ट्याउन सकिँदैन।") }
  var clear: String { value("Clear", "हटाउनुहोस्") }
  var cancel: String { value("Cancel", "रद्द गर्नुहोस्") }
  var neverLearnInApps: String { value("Never learn in selected apps", "छानिएका एपमा कहिल्यै नसिक्नुहोस्") }
  var neverLearnInAppsDetail: String { value("Choose editors, work apps or other places where personal learning should stay off. Password fields are always protected.", "व्यक्तिगत सिकाइ बन्द राख्नुपर्ने editor, कामका एप वा अन्य ठाउँ छान्नुहोस्। Password field सधैं सुरक्षित हुन्छन्।") }
  var chooseExcludedApplications: String { value("Choose applications where Lekh should never learn", "Lekh ले कहिल्यै नसिक्ने एप छान्नुहोस्") }
  var addApplications: String { value("Add Applications…", "एप थप्नुहोस्…") }
  var noExcludedApplications: String { value("No apps excluded", "कुनै एप बहिष्कृत छैन") }
  var removeApplication: String { value("Remove", "हटाउनुहोस्") }

  var diagnosticsTitle: String { value("Know exactly what is running", "के चलिरहेको छ ठ्याक्कै जान्नुहोस्") }
  var diagnosticsBody: String { value("This page reports installation, activation and signing state without collecting typed content.", "यो पृष्ठले टाइप गरिएको सामग्री नलिई installation, activation र signing स्थिति देखाउँछ।") }
  var keyboardBundle: String { value("Native keyboard", "नेटिभ किबोर्ड") }
  var registeredSources: String { value("Registered sources", "दर्ता भएका स्रोत") }
  var signature: String { value("Code signature", "कोड हस्ताक्षर") }
  var signedProduction: String { value("Developer ID signed", "Developer ID हस्ताक्षरित") }
  var developmentBuild: String { value("Development build", "विकास build") }
  var unavailable: String { value("Unavailable", "उपलब्ध छैन") }
  var registeredState: String { value("Registered", "दर्ता") }
  var enabledState: String { value("Enabled", "सक्षम") }
  var selectedState: String { value("Selected", "चयनित") }
  var runningState: String { value("Engine running", "इन्जिन चलिरहेको") }
  var buildState: String { value("Runtime build", "रनटाइम build") }
  var buildMatched: String { value("Matches installed build", "इन्स्टल भएको build सँग मिल्छ") }
  var buildMismatched: String { value("Mismatch", "मिलेन") }
  var notVerified: String { value("Not verified", "प्रमाणित छैन") }
  var yes: String { value("Yes", "हो") }
  var no: String { value("No", "होइन") }
  var copyDiagnostics: String { value("Copy Safe Diagnostics", "सुरक्षित diagnostics कपी गर्नुहोस्") }
  var diagnosticsFootnote: String { value("Diagnostics include versions, states and counts only—never keys, words or surrounding text.", "Diagnostics मा version, स्थिति र गणना मात्र हुन्छ—कहिल्यै key, शब्द वा वरपरको पाठ हुँदैन।") }
  var deterministicEngine: String { value("Deterministic engine", "निर्धारित इन्जिन") }
  var runtimeHealth: String { value("Runtime connection", "रनटाइम जडान") }
  var localDictionary: String { value("Local dictionary", "स्थानीय शब्दकोश") }
  var neuralFallback: String { value("Neural fallback", "न्यूरल fallback") }
  var modelArtifact: String { value("Model artifact", "मोडेल artifact") }
  var ready: String { value("Ready", "तयार") }
  var assetsPresent: String { value("Assets present · runtime unverified", "फाइलहरू उपलब्ध · रनटाइम अप्रमाणित") }
  var incomplete: String { value("Incomplete", "अपूर्ण") }
  var productionVerified: String { value("Production verified", "उत्पादनका लागि प्रमाणित") }
  var manifestClaimUnverified: String { value("Manifest claim · unverified", "म्यानिफेस्ट दाबी · अप्रमाणित") }
  var experimentalLocalFallback: String { value("Experimental · local only", "प्रयोगात्मक · स्थानीय मात्र") }
  var packagedDisabled: String { value("Packaged · disabled", "प्याकेज गरिएको · बन्द") }
  var notPackaged: String { value("Not packaged", "प्याकेज गरिएको छैन") }
}
