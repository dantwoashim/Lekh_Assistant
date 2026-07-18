# Third-Party Notices

## dictionary-ne 2.0.0

- Source: `https://github.com/wooorm/dictionaries/tree/main/dictionaries/ne`
- npm tarball: `https://registry.npmjs.org/dictionary-ne/-/dictionary-ne-2.0.0.tgz`
- License: LGPL-2.1 for Nepali Hunspell dictionary and affix data; MIT for package wrapper.
- Use in this repository: Preeti test fixture generation, ignored dictionary review reports, ranked local lexical expansion, and lazy-loaded browser-local spell validation through `nspell`.
- Attribution from package license: Nepali SpellChecking Dictionary, compiled by Madan Puraskar Pustakalaya, Patan Dhoka, Lalitpur, Nepal.
- Replacement path: update the `dictionary-ne` npm dependency, keep this notice current, rerun `npm run test`, `npm run build`, `npm run check:privacy`, and `npm run verify`, then review any spell-suggestion behavior changes before release.

## nspell 2.1.5

- Source: `https://github.com/wooorm/nspell`
- npm package: `https://www.npmjs.com/package/nspell`
- License: MIT.
- Use in this repository: local Hunspell-style spell validation in the browser.

## saxes 6.0.0

- Source: `https://github.com/lddubeau/saxes`
- npm package: `https://www.npmjs.com/package/saxes`
- License: ISC; its `xmlchars` dependency is MIT.
- Use in this repository: strict, namespace-aware parsing of the bounded macOS update appcast in the Electron companion.

## @nepalibhasha/converter 0.1.0

- Source: `https://github.com/nepalibhasha/nepali-fonts/tree/main/packages/converter-js`
- npm package: `https://www.npmjs.com/package/@nepalibhasha/converter`
- License: MIT.
- Use in this repository: baseline legacy-font conversion for Preeti and related font profiles, wrapped by project normalization and warning handling.

## GlobalPolicy UnicodeToPreeti

- Source: `https://github.com/globalpolicy/UnicodeToPreeti`
- License: MIT.
- Use in this repository: algorithm reference for `scripts/lib/unicodeToPreeti.ts`, used only to generate Preeti conversion fixtures.
