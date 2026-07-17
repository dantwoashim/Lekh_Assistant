cask "lekh-keyboard-test" do
  version "0.1.0,170"
  sha256 "4a22efefefcae0712d272b4e04b4c3b83d1b2371237bbe47c5e0b2f9362e5c79"

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
