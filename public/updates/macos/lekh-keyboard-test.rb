cask "lekh-keyboard-test" do
  version "1.0.0,278"
  sha256 "b96c393797e18e15d51965979e700c6fb8c370de4a480e144b711f9f83e8b3eb"

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
