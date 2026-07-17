cask "lekh-keyboard-test" do
  version "0.1.0,172"
  sha256 "f969229e4790d77cca59d8d49b88fd083c66dc47dcbd31a34a2b8c63f70429ad"

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
