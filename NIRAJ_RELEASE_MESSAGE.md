# Draft message for Niraj

Hi Nirajji,

Lekh Assistant v1.0.0 is ready for your release-candidate check. For your Mac,
please use the attached file **`Lekh-Keyboard-Test-Installer.zip`**. It is the
same universal Apple Silicon + Intel build produced by the final-reviewed CI
run. Backup download: [macOS universal artifact](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/artifacts/8514727670)
(GitHub may ask you to sign in). The complete bundle is also available
[here](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/artifacts/8514757020)
as **`lekh-assistant-v1.0.0-release-candidate`**; it also contains the Windows
file **`Lekh-Keyboard-Companion-1.0.0-Setup-x64.exe`**.

The expected SHA-256 for the Mac file is
`5c69e7ab94b6d63b4fdd0541cec2ca0c820605f857bd16032563274572b9a4f1`.

Please install it in exactly three steps:

1. Download and double-click `Lekh-Keyboard-Test-Installer.zip`, then open the
   extracted `Lekh Keyboard Test Installer` folder without renaming or moving
   anything inside it.
2. Control-click or right-click `Lekh Keyboard Test Installer.app`, choose
   **Open**, click **Open** again, wait for the installer result, and click
   **OK**.
3. Save your work, log out of the Mac and back in, then go to **System Settings
   → Keyboard → Text Input → Edit… → + → Nepali → Lekh Keyboard → Add** and
   select **Lekh Keyboard** from the menu-bar input-source icon.

If macOS still blocks step 2, use **System Settings → Privacy & Security → Open
Anyway**. Only as a last resort, run
`xattr -dr com.apple.quarantine "/exact/path/to/Lekh Keyboard Test Installer.app"`
against that app only, then repeat step 2.

Honest limitations: this is an ad-hoc-signed, unnotarized build because we do
not have a paid Apple Developer ID, so macOS must ask you to approve it; the
Windows build is also unsigned. Romanized typing and suggestions use the local
deterministic engine, while experimental neural typing is disabled and absent
from the package. Traditional typing is labeled Beta, proofread is conservative
rather than full grammar correction, Windows ARM64 is not shipped, physical
use in every host app has not been claimed, and there is no automatic update
service.

After trying it, could you please answer these three questions?

1. After the required logout/login, did **Lekh Keyboard** appear under Nepali,
   and could you type `namaste`, choose a suggestion, and get `नमस्ते` in your
   normal app?
2. Which Mac model, macOS version, and apps did you test, and did any Latin
   email, URL, abbreviation, or password-field text change unexpectedly?
3. Were Romanized suggestions, Dictionary, Proofread, and the Traditional Beta
   mode understandable and useful; if anything was wrong, what exact text did
   you type and what appeared?

Thank you.
