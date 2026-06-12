# Lekh Keyboard Scope Freeze

Generated: 2026-05-27

This document freezes the keyboard-first product scope for the Lekh Keyboard phase.

## Core Product

Lekh Keyboard is a local-first Windows/macOS Nepali keyboard product.

The core product includes:

- Romanized typing.
- Traditional typing.
- Live suggestions while typing.
- Proofread hints while typing.
- Dictionary support while typing.
- Local correction memory.
- Local-first privacy.
- A premium companion app for settings, dictionaries, memory, diagnostics, and utilities.

The keyboard roadmap must not be blocked by advanced Preeti document repair. The keyboard engine must prioritize live Romanized and Traditional typing.

## Side Utility

Preeti to Unicode conversion remains valuable, but it is not the center of the keyboard roadmap.

Preeti/legacy tools belong in:

- companion app document tools;
- Preeti converter utility tab;
- legacy-font diagnostics;
- office-document cleanup workflows;
- benchmark and validation tools.

These utilities must stay local-first and safe, but they must not block the live keyboard state machine.

## Deferred Scope

The following are deferred until the keyboard foundation and typing intelligence are stable:

- advanced mixed-document repair inside the IME hot path;
- cloud sync;
- account system;
- mobile keyboard;
- voice input;
- handwriting input;
- OCR;
- rewriting or translation features;
- enterprise dashboard;
- native production TSF/IMK implementation during Prompt 1;
- Rust hot-path port before profiling proves the need.

## Product Language

Use keyboard-first language:

- "Windows/macOS Nepali keyboard"
- "Romanized and Traditional typing"
- "live suggestions"
- "proofread and dictionary while typing"
- "local-first"

Avoid positioning Lekh Keyboard as:

- a browser-only converter;
- a Preeti-first product;
- a document repair app;
- a clone of older layout tools;
- a cloud writing service.

## Current Browser Prototype Role

The browser prototype is an engine lab and demo surface. It is useful for:

- validating the `KeyboardEngine` session API;
- comparing Romanized and Traditional behavior;
- inspecting candidates, proof hints, warnings, and latency;
- running developer feedback loops before native work.

It is not the final keyboard product.

## Prompt 1 Boundary

Prompt 1 implements:

- scope freeze;
- Traditional layout audit scaffolding;
- `KeyboardEngine` API;
- session lifecycle;
- composition and commit semantics;
- browser/web-lab simulation;
- typing-session benchmark harness;
- native feasibility specifications.

Prompt 1 does not implement:

- production Windows TSF;
- production macOS IMK;
- full Traditional layout engine;
- Rust port;
- Tauri companion app;
- monorepo restructuring.
