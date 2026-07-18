# Lekh macOS Community Preview — Trust Boundary

This artifact is an engineering preview built on GitHub-hosted macOS infrastructure from the commit recorded by its GitHub artifact attestations. It is ad-hoc signed so macOS can validate internal bundle integrity.

It is **not** signed with an Apple Developer ID, **not** notarized by Apple, and **not** a Gatekeeper-trusted production release. The GitHub build-provenance and SBOM attestations do not replace Apple Developer ID signing, Apple notarization, Windows Authenticode, SmartScreen reputation, platform approval prompts, or independent security review.

The accompanying SPDX 2.3 SBOM inventories every regular file and symbolic link in the preview input-method bundle and binds the package record to the SHA-256 digest of the distributed ZIP. `SHA256SUMS.txt` provides the same artifact digest for ordinary checksum verification.

Verify the GitHub attestations after downloading the ZIP:

```sh
gh attestation verify Lekh-Keyboard-macOS-Community-Preview-UNSIGNED.zip --repo OWNER/REPOSITORY
```

Only use this preview for controlled testing. Keep the provenance notice, SBOM, and checksum beside the ZIP so its trust limitations remain visible.
