cask "lekh-keyboard-test" do
  version "0.1.0,6"
  sha256 "ce16789a3a57ee58851db468389a4b782a64453839029f4f66891b1b931eae3e"

  url "https://lekh-assistant.pages.dev/updates/macos/Lekh-Keyboard-Test-Installer.zip"
  name "Lekh Keyboard"
  desc "Native macOS Nepali input method"
  homepage "https://lekh-assistant.pages.dev/"

  installer script: {
    executable: "Lekh Keyboard Test Installer/Install Lekh Keyboard from Terminal.command",
    sudo: false
  }

  uninstall script: {
    executable: "Lekh Keyboard Test Installer/Uninstall Lekh Keyboard from Terminal.command",
    sudo: false
  }
end
