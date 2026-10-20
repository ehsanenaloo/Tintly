# Testing

Run everything from the repository root. You need Node.js 22 or newer and `npm install`.

## The suites

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run check` | Static checks (`npm run validate`), the site data check (`npm run data:check`), the type check (`npm run types`) and the unit tests (`npm test`). | Node.js |
| `npm run test:browser` | Real Chromium with the unpacked extension against local fixture pages. | `npx playwright install chromium`, once |
| `npm run test:firefox` | The same idea in real Firefox. | Firefox installed |
| `npm run test:perf` | Speed and size budgets. | Chromium, a quiet machine |
| `npm run lint:firefox` | Builds the Firefox package and runs the add-on linter on that exact file. | Node.js |
| `npm run audit` | `npm audit` for findings of high severity or more. | Network |

Packages: `npm run build` writes the Chrome and Edge zip to `dist/`, and `npm run build:firefox` writes the Firefox zip. The zip writer is deterministic, so a second build gives the same bytes.

## Static checks

`npm run validate` reads the whole tree and fails on:

- a manifest that is not valid, a permission or host that no code uses, or a permission with no row in [PRIVACY.md](PRIVACY.md),
- banned code patterns: `innerHTML`, `eval`, `new Function`, inline event handlers and similar,
- physical CSS properties where a logical one is needed (for right-to-left layouts),
- a missing, extra or empty text in a language file, a changed placeholder, a text key used in code but missing in English, and a key that no code uses,
- a file or folder in the repository root that is not on the list,
- a bad site data file.

## Unit tests

`tests/unit/` uses the built-in `node:test` runner with no install. They cover color math, style rewriting, settings and their migration, storage and sync, the schedule math, site matching, messages, the network proxy limits, packaging, the loader and the security rules for hostile input. Unit tests do not check rendering.

## Browser tests

`tests/browser/` starts a real Chromium with the extension and local fixture pages from `tests/browser/fixtures/`. A fixture is a small page that holds one pattern: a gradient, a shadow root, a late style sheet, a huge page. Tests check computed colors, contrast, what is left alone, the popup, the settings page, the fix editor, frames, timing guards and security rules.

Run one file: `node --test tests/browser/popup.test.mjs`. Run them all in one process with `npm run test:browser`, or in parallel groups with `npm run test:browser:parallel`.

Browser tests use local pages only. They do not load live sites. A passing run does not prove that a live site looks right, because sites change.

## Firefox tests

`tests/firefox/` drives a real Firefox with the package built by `npm run build:firefox`. When the `CI` variable is set and Firefox is missing, the tests fail instead of skipping.

## Performance tests

`npm run test:perf` measures against budgets written in `tests/perf/run.mjs`:

- **P-01.** The extra script time on a page where Tintly is off.
- **P-02a.** The size of the content scripts that every page loads.
- **P-02t.** The compile and run time of the files that an empty page loads, at normal speed and with the processor slowed down.
- Other rows cover the time of the gate, the full pass of the engine on a typical and a heavy page, popup open time, the cost of the E-ink mode against Dark, and the time to load an on-demand part.

Numbers are valid only for the machine and browser that produced them. A busy machine moves them by a large factor, so repeat a run before you call a change a speed-up or a slowdown. Each result records the machine and the browser version. `DK_PERF_ONLY=size npm run test:perf` runs the size rows only.

## Site data

`npm run data:build` checks every entry of `data-src/` and writes the shards under `extension/data/`. `npm run data:check` fails if the files on disk differ from what the build would write.

## In CI

`.github/workflows/ci.yml` runs on a push to `main` and on pull requests with read-only permissions. It runs the check, audit and Firefox lint, builds both packages twice and compares the bytes, and runs a smaller set of Chromium and Firefox browser tests. The full browser suite and the performance tests stay local because they are long and sensitive to timing.

## What the tests do not show

- Live sites. Use the [page looks wrong form](https://github.com/ehsanenaloo/Tintly/issues/new?template=site_breakage.yml) when one looks wrong.
- Real E-ink hardware, and screen readers. The interface is tested with the keyboard, forced colors and reduced motion in Chromium.
- Browsers other than Chromium and Firefox. Edge uses the Chrome package.
