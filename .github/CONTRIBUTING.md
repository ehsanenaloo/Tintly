# Contributing to Tintly

Thank you for wanting to help. Tintly is a browser extension for Chrome, Edge and Firefox that makes web pages dark, light or paper-like. It gets better when people report pages that look wrong, fix text and send small patches. A clear report is a real contribution.

By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contents

- [Ways to contribute](#ways-to-contribute)
- [Project rules](#project-rules)
- [Set up](#set-up)
- [Run it in a browser](#run-it-in-a-browser)
- [Checks and tests](#checks-and-tests)
- [Branches, commits and the version](#branches-commits-and-the-version)
- [Fix the pattern, not the site](#fix-the-pattern-not-the-site)
- [Add a site fix](#add-a-site-fix)
- [Speed rules](#speed-rules)
- [Privacy and permission changes](#privacy-and-permission-changes)
- [Interface text and languages](#interface-text-and-languages)
- [Report a bug well](#report-a-bug-well)
- [Labels](#labels)
- [Pull request checklist](#pull-request-checklist)
- [Security](#security)
- [Decisions and releases](#decisions-and-releases)
- [License](#license)

## Ways to contribute

- Report a bug, or a page that looks wrong, with the [issue forms](https://github.com/ehsanenaloo/Tintly/issues/new/choose).
- Fix a translation or add a language.
- Improve the documentation.
- Add a test page that rebuilds a pattern you found.
- Send a small, focused pull request. For anything big, open an issue first and describe the problem. This saves you work if the idea does not fit.

Ask questions in [Discussions](https://github.com/ehsanenaloo/Tintly/discussions). See [SUPPORT.md](SUPPORT.md) for what goes where.

## Project rules

These rules decide most reviews.

1. **Fix the pattern, not the site.** Engine code never names a site or a host. See below.
2. **No network, no telemetry.** The extension makes no request except to fetch the style sheets and pictures of the page the user is on. No analytics, no remote settings, no remote code.
3. **Colors only.** Tintly changes colors, fonts and the color-scheme hint. It must not change what a page shows, sends or stores. A site that is switched off gets nothing from Tintly.
4. **Few permissions.** A new permission or a new host needs an issue first, with the reason.
5. **Fast.** A page that is off pays almost nothing. The speed budgets are tests.
6. **No build step.** `extension/` is the extension exactly as it ships: plain JavaScript, HTML, CSS and JSON. No framework, bundler, minifier or runtime dependency.
7. **Render text as text.** Never build HTML from page text, stored settings, imported files or translated strings. Use `textContent` and DOM calls. No `innerHTML`, `eval`, `new Function`, inline event handlers or remote scripts. `npm run validate` fails on them.
8. **Original work.** Do not copy code, data files, text or images from another project. Write your own.

## Set up

You need Node.js 22 or newer and Git.

```bash
git clone https://github.com/ehsanenaloo/Tintly.git
cd Tintly
npm install
npm run hooks:install
npm run check
```

`.npmrc` sets `ignore-scripts=true`, so installing a package never runs its install script. Keep it that way.

`npm run hooks:install` adds a pre-commit hook. It refuses a commit that changes `extension/` without a new version (see below).

## Run it in a browser

**Chrome or Edge.** Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose Load unpacked and pick the `extension/` folder. After a change, choose the reload button of the extension.

**Firefox.** Run `npm run build:firefox`, open `about:debugging`, choose This Firefox, then Load Temporary Add-on and pick the zip in `dist/`. Do not edit `extension/manifest.json` for Firefox. `scripts/build-firefox.mjs` rewrites only the generated manifest.

Logs: the service worker has its own console (the Inspect link on the extensions page). The content script logs show in the console of the page. The popup, the settings page and the fix editor have their own consoles.

## Checks and tests

| Command | What it does |
| --- | --- |
| `npm run check` | Static checks, data check, type check and unit tests. Run this before every push. |
| `npm run build` | Builds the Chrome and Edge zip in `dist/`. |
| `npm run build:firefox` | Builds the Firefox zip in `dist/`. |
| `npm run lint:firefox` | Builds the Firefox zip and runs the add-on linter on that file. |
| `npm run audit` | `npm audit` for high findings. |
| `npm run test:browser` | Real Chromium with the unpacked extension and local fixture pages. Run `npx playwright install chromium` once. |
| `npm run test:firefox` | The same idea in real Firefox. Firefox must be installed. |
| `npm run test:perf` | Speed and size budgets. |

[docs/TESTING.md](../docs/TESTING.md) explains the suites. Pick the checks that fit your change and say which you ran. Do not edit a test to make a failure go away. If a test and the code disagree, find out which one is right.

Tests that touch the page use small fixture pages in `tests/browser/fixtures/`. A fixture holds only the pattern under test. Passing tests do not prove that live sites work, because sites change. For a visible change, look at the real popup, settings page or fix editor in a light and a dark look, in a left-to-right and a right-to-left language, and say what you looked at.

## Branches, commits and the version

- Branch from `main`. Use a short name such as `fix/sticky-header-contrast` or `docs/testing-notes`.
- One topic per pull request.
- Commit messages: a short title in the imperative mood ("Keep the focus ring in E-ink mode"), then a body that says why when it is not obvious. No trailers that name a tool or an assistant.
- Every change under `extension/` raises the version, so the person who loads a build can tell which build it is. Run `npm run version:bump` (patch for a fix, `npm run version:bump minor` for a feature). It updates `extension/manifest.json`, `package.json` and `package-lock.json` together. `npm run version:status` tells you whether the version is stale. A change that touches only tests, scripts or documents does not raise it.
- Add a short line under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) if a user can see or feel the change. Write it for users in plain words. Do not put file names or issue numbers in it, and do not claim anything you did not measure or try.

## Fix the pattern, not the site

When a page looks wrong, find the CSS or script pattern behind it and fix it in the engine, so every site with the same pattern gets the fix.

1. Rebuild the pattern in a small page in `tests/browser/fixtures/`.
2. Write a browser test that fails.
3. Fix the engine. Never write code that names a site or a host.
4. Keep the fixture and the test.

A per-site fix is data, not engine code. Use one only when no general rule can work, and say so in the pull request.

## Add a site fix

Site fixes live in `data-src/fixes/*.json`. Each file maps a site pattern to a fix. A pattern is a host such as `example.com`, or a host plus a path such as `example.com/docs`.

1. Build the fix in the fix editor of the extension (the Site fixes link in the toolbar window), then use **Copy fix** to get its text. The fields are described in the user guide.
2. Put the entry in a file in `data-src/fixes/`. Every entry needs a `note` that says why it exists and a `verified` field with `date`, `browsers` and `test` (a fixture or a page you checked).
3. Run `npm run data:build`. It checks every entry, checks the selectors and writes the shards under `extension/data/`. `npm run data:check` must pass.
4. Shipped CSS may only recolor. It may not use `@import`, `@font-face`, `url()` or other things that load a file.
5. Open the pull request with the page address and a before and after picture. Do not post private pages.

Before you add a fix, ask whether the problem is a pattern that three sites share. If so, the engine should change instead.

Fixes never run code. A site list also has a dark-site file, `data-src/dark-sites.json`, for hosts that are dark by default.

## Speed rules

A dark mode runs on every page a person opens, so a small cost becomes a large one. The budgets are in `tests/perf/run.mjs` and `npm run test:perf` checks them.

- **P-01.** A page where Tintly is off pays almost nothing. The extra script time on such a page has a small budget.
- **P-02a.** The size of the content scripts that every page loads is capped. New code that a page needs only sometimes belongs in an on-demand part, loaded when the gate asks for it.
- **P-02t.** The compile and run time of the files that an empty page loads is capped, at normal speed and with the processor slowed down.
- Work is split into short slices. Never read layout in the hot path. Never touch `Function.prototype.toString`, `Error.prepareStackTrace` or other built-ins that a page can see.
- No timers or polling while a page is idle. Use observers.

If your change moves a number, run `npm run test:perf` before and after on the same machine and put both in the pull request. Do not call a slowdown noise without a repeat run.

## Privacy and permission changes

These need an issue first.

- A new permission or host.
- A new network request, or a request to a new address.
- A new storage key, or a change to what is stored.
- Anything that reads more of a page than its styles and pictures.
- Analytics, remote code or a third-party service. These are not accepted.

If a change is accepted, the same pull request updates [docs/PRIVACY.md](../docs/PRIVACY.md). `npm run validate` fails when a declared permission is unused or has no row there.

Storage keys and message names are a contract. People have data under those names. A rename needs a migration.

## Interface text and languages

Tintly ships in Persian (`fa`), English (`en`), Arabic (`ar`) and Hebrew (`he`). The last three need no special care in code, but all four must stay complete.

**Change a text.**

1. Add or change the key in `extension/shared/locales/en.js`. English is the source.
2. Add the same key to `fa.js`, `ar.js` and `he.js`.
3. Keep every `{placeholder}` exactly as it is in English.
4. Use the key in code with `t('key')` or `data-i18n`. Show text with `textContent`.

`npm run validate` fails on a missing key, an extra key, an empty value, a changed placeholder, a key used in code but missing in English, and a key that no code uses.

**Add a language.**

1. Add `extension/shared/locales/<code>.js` with every key of `en.js`.
2. Add one line to the `LOADERS` list in `extension/shared/i18n.js`. If the language is written right to left, add its code to `RTL_LOCALES` in the same file.
3. Add `extension/_locales/<code>/messages.json` with the same keys as `en` (name, description and shortcut labels). Use the browser's folder naming.
4. Run `npm run check`, then open the popup and the settings page in the new language. For a right-to-left language check that the layout mirrors. The styles use logical properties (`margin-inline-start`, not `margin-left`), and the check fails on physical ones.
5. Tell us in the pull request whether you are a native speaker, fluent, or used a tool and checked the result yourself.

Write natural text for the people who speak the language. Do not translate word by word. Keep the product terms (Tintly, E-ink, Paper) and the names of the browser features as they are.

You can also open the [translation fix form](https://github.com/ehsanenaloo/Tintly/issues/new?template=translation_fix.yml) if you do not want to edit code. [TRANSLATING.md](../docs/TRANSLATING.md) has the same steps in one page.

A fix from a native speaker is the most useful contribution here.

## Report a bug well

A good report lets someone else see the problem in a few minutes. Include:

- the extension version (shown in the toolbar window, in the About dialog and on the extensions page of your browser), your browser and its version, and your operating system,
- the address of the page, or a small page that shows the same thing (do not post private or signed-in pages),
- the mode (Dark, Light, Paper or E-ink) and the engine,
- whether a site rule, a fix, a schedule or a preset was set for the page,
- what you expected and what happened, with a screenshot of the page with Tintly on, and one with it off if you can,
- other extensions that change page colors, which can conflict,
- the smallest set of steps that shows the problem.

Use the **Page looks wrong** form for a page and the **Bug report** form for anything else. Search the existing issues first. Do not post passwords, personal pages or private data.

## Labels

Labels are listed in `.github/labels.yml`.

| Label | Meaning |
| --- | --- |
| `bug` | Something does not work as expected |
| `site-breakage` | A page looks wrong |
| `enhancement` | A new feature or an improvement |
| `documentation` | Docs and guides |
| `translation` | A translation fix or a new language |
| `accessibility` | Keyboard, screen reader, contrast, forced colors, reduced motion, right to left |
| `performance` | Speed or memory |
| `privacy` | Data, permissions or network |
| `good first issue` | Small and well described |
| `help wanted` | Help is welcome |
| `question` | A usage question |
| `needs triage` | Not reviewed yet |
| `blocked` | Waiting on something else |
| `duplicate`, `invalid`, `wontfix` | Closed without work |
| `security` | Security related. Report vulnerabilities privately |
| `dependencies` | Updates to GitHub Actions and dev tools |

## Pull request checklist

The pull request template has the same list.

- [ ] The change is focused and the description says why it is needed.
- [ ] `npm run check` passes.
- [ ] I added or updated a test, or I explained why it cannot be tested.
- [ ] A fix for a page rebuilds the pattern in a fixture and does not name a site in engine code.
- [ ] I tried the change in a real browser, including a failure case.
- [ ] No new permission, host, network request or storage key, or it was agreed in an issue first.
- [ ] The version was raised if I changed `extension/`.
- [ ] Interface text is in all four language files with the same placeholders.
- [ ] It works with the keyboard and in a right-to-left language.
- [ ] I checked the speed budgets if I touched the engine, the gate or the manifest.
- [ ] `CHANGELOG.md` and the docs are updated if a user can see the change.
- [ ] Screenshots and test files contain no private data.
- [ ] I wrote this change or I have the right to submit it under the MIT License.

## Security

Do not open a public issue for a security problem. Follow [SECURITY.md](SECURITY.md) and use the private vulnerability report.

## Decisions and releases

Tintly is maintained by [Ehsan Enaloo](https://github.com/ehsanenaloo). The maintainer makes the final call on what is merged, using the project rules above and the results of CI. A "no" to a feature is not a judgment about you. Often the idea needs a permission or a service that this project does not want. You are always free to fork the project under the MIT License.

Releases are made by the maintainer: the version is raised, the changelog gets a section, two packages are built (`npm run build` and `npm run build:firefox`), and the packages are uploaded to the browser stores. Store links are not live yet.

## License

Tintly is released under the [MIT License](../LICENSE). By opening a pull request you confirm that you wrote the change, or that you have the right to submit it under that license. No sign-off line is needed.
