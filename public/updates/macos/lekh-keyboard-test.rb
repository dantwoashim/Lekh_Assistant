cask "lekh-keyboard-test" do
  version "0.1.0,177"
  sha256 "7763e82e9d33a96d925c647f35d16b528d7784fc984c38f40e86049e2387bfbf"

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
