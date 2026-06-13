# Lekh Release Signing Public Keys

These public keys are safe to publish. Private signing keys must stay outside the repository and only be available on the release machine or release CI.

## Dictionary Packs

Raw Ed25519 public key, Base64:

```text
leXuq4+d5aRli02qEchU+UEo7qRbrzB1kpA21t+5nHY=
```

Used by the macOS input method to verify signed dictionary-pack manifests before loading a runtime pack.

## Sparkle App Updates

Sparkle `SUPublicEDKey`:

```text
iKAPpQHHx7GBhsTDmadt3rilfhhPKo2RdqV2Q0/zN6U=
```

Used by Sparkle 2 appcast update verification.

## Release Manifest

Minisign public key:

```text
untrusted comment: minisign public key E8FA46D04F3AE5E7
RWTn5TpP0Eb66L+FGf3KnXjxWNmDSvTv1Ac6u8rpflmN2iYNmFxNGSv9
```

Used to verify the detached signature for `RELEASE-MANIFEST.json`.
