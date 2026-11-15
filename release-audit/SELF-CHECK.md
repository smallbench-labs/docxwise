# Docxwise 0.1.0 — Obsidian review self-check (2026-11-15, Asia/Taipei)

Official sources (fetched 2026-11-15 from github.com/obsidianmd/obsidian-developer-docs, copies in `official/`):
Plugin guidelines, Submission requirements for plugins, Developer policies, Submit your plugin, Release your plugin with GitHub Actions.
Linter: eslint-plugin-obsidianmd 0.6.0 `recommended` (ESLint 9, typescript-eslint 8, TypeScript 5; installed only in `lint/`),
plus its documented community-scanner notes (`official/eslint-plugin-configuration.md`).

## ESLint
- Before: 84 problems (59 errors, 25 warnings) — `eslint-before.txt`
- After: 0 errors, 1 warning — `eslint-after.txt`
  - Remaining warning `settings-tab/prefer-setting-definitions` (Obsidian 1.13+ settings search). Kept on purpose:
    minAppVersion is 1.5.0, where `display()` is required (`settings-tab/require-display`).
- Extra run with `ui/sentence-case` (off in the scanner): 10 flags, all proper nouns (Docxwise Pro, Word, Japan,
  Files app, Zotero) or a lowercase string the rule misread; no change.
- Fixes: typed the citeproc-js engine (types.d.ts) instead of `any`; markdown-it `Env`/token meta types; bibliography
  marker via WeakSet instead of `(p as any).__bib`; IRunOptions-typed literals (false "deprecated italics" hits);
  Mermaid API type; unnecessary assertions; useless regex escape; `document` -> `activeDocument` (popout windows).

## Manual checklist
| Item | Result |
|---|---|
| manifest `id` "docxwise" (no "obsidian", unique as of 11-14 check) | pass, unchanged |
| description: action start, 136 chars (<=250), ends with ".", no emoji, "Pandoc" capitalised | pass, unchanged |
| minAppVersion 1.5.0 | pass by lint `no-unsupported-api` (dropping to 1.0.0 flags AbstractInputSuggest = 1.4.10; 1.5.0 flags nothing). Runtime only tested on 1.15.1 (older versions 未查證) |
| isDesktopOnly false | pass: main.js requires only `obsidian`; lint `no-nodejs-modules` clean; real Obsidian 1.15.1 export OK in desktop and `app.emulateMobile(true)`; real phone 未查證 |
| authorUrl https://github.com/smallbench-labs | pass (same as Streakwise) |
| fundingUrl | absent — correct (only for donations; Pro purchase is not funding) |
| versions.json {"0.1.0":"1.5.0"} | pass |
| innerHTML / outerHTML / insertAdjacentHTML | none |
| heavy work in onload | none: settings load + command/ribbon/menu/tab registration; license check deferred to onLayoutReady and only with a key. Measured enable time 49/32/28 ms (3 runs) |
| cleanup | events via registerEvent; commands/ribbon/tab auto-removed; DOM listeners only on elements owned by settings/notice |
| console | console.warn (Mermaid failure) removed; only console.error on unexpected export failure |
| default hotkeys | none (checked in Obsidian: hotkeys null for all 3 commands) |
| command ids/names without plugin id/name | pass (lint rules) |
| settings: no top-level heading, no "settings" in headings, setHeading | pass ("Citations", "Pro") |
| styles.css only Obsidian variables | fixed: 3 `color-mix(..., black/white)` -> `var(--text-normal)`; no inline styles in code (lint `no-static-styles-assignment`) |
| sample code / placeholder names | none |
| README disclosures: payment, network, 14-day refund, not sold in Japan | present; region-check log sentence corrected to match the privacy draft (Worker logging off) |
| LICENSE | MIT, copyright line aligned with smallbench-labs/streakwise |
| third-party licenses | THIRD_PARTY_NOTICES.md regenerated from node_modules (17 components, full texts, CPAL 3.6 notice); appended to main.js; header at top of main.js; citeproc source tarball in third_party/ |

## Reviewer risks (not errors)
- `app.openWithDefaultApp` / `app.showInFolder` are not in the public API typings (guarded with optional calls).
- Dataview accessed via `app.plugins.plugins.dataview.api` (common pattern, guarded).
- main.js is 1,606,483 bytes (gzip 402,905).
