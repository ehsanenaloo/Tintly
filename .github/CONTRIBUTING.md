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
7. **Render text as text.** Never build HTML from page text, stored settings, imported files or translated strings. Use `textContent` and DOM calls. No `innerHTML`, `eval`, `new Function`, inline event handlers or remote scripts. The maintainer's checks fail on them.
8. **Original work.** Do not copy code, data files, text or images from another project. Write your own.

## Set up

You need Git and a browser. Nothing else to install.

```bash
git clone https://github.com/ehsanenaloo/Tintly.git
```

The folder `extension/` is the extension itself. You can load it as it is.

## Run it in a browser

**Chrome or Edge.** Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose Load unpacked and pick the `extension/` folder. After a change, choose the reload button of the extension.

**Firefox.** Firefox needs its own package, and the maintainer builds it from the same `extension/` folder. You cannot load `extension/` in Firefox as it is. To try Tintly in Firefox, install it from Firefox Add-ons. Do not edit `extension/manifest.json` for Firefox.

Logs: the service worker has its own console (the Inspect link on the extensions page). The content script logs show in the console of the page. The popup, the settings page and the fix editor have their own consoles.

## Checks and tests

Test your change by hand. Load `extension/` in Chrome or Edge and try it on real pages, including a case that should fail.

The checks, the builds and the tests are kept by the maintainer and are not in this repository. The maintainer runs them on every change before it is merged, and adds the tests that your change needs. In the pull request, say what you tried by hand. Passing tests do not prove that live sites work, because sites change. For a visible change, look at the real popup, settings page or fix editor in a light and a dark look, in a left-to-right and a right-to-left language, and say what you looked at.

## Branches, commits and the version

- Branch from `main`. Use a short name such as `fix/sticky-header-contrast` or `docs/testing-notes`.
- One topic per pull request.
- Commit messages: a short title in the imperative mood ("Keep the focus ring in E-ink mode"), then a body that says why when it is not obvious. No trailers that name a tool or an assistant.
- Do not change the version in a pull request. Every change under `extension/` gets a new version, so the person who loads a build can tell which build it is. The maintainer raises it when the change is merged.
- Add a short line under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) if a user can see or feel the change. Write it for users in plain words. Do not put file names or issue numbers in it, and do not claim anything you did not measure or try.

## Fix the pattern, not the site

When a page looks wrong, find the CSS or script pattern behind it and fix it in the engine, so every site with the same pattern gets the fix.

1. Rebuild the pattern in a small page. Put the page in the pull request or the issue, not in the repository.
2. Fix the engine. Never write code that names a site or a host.
3. The maintainer adds the page and a test to the private suite.

A per-site fix is data, not engine code. Use one only when no general rule can work, and say so in the pull request.

## Add a site fix

Site fixes live in `data-src/fixes/*.json`. Each file maps a site pattern to a fix. A pattern is a host such as `example.com`, or a host plus a path such as `example.com/docs`.

1. Build the fix in the fix editor of the extension (the Site fixes link in the toolbar window), then use **Copy fix** to get its text. The fields are described in the user guide.
2. Put the entry in a file in `data-src/fixes/`. Every entry needs a `note` that says why it exists and a `verified` field with `date`, `browsers` and `test` (a fixture or a page you checked).
3. Change only `data-src/`. Do not edit the files under `extension/data/`. The maintainer builds them from `data-src/`, and the build checks every entry and its selectors.
4. Shipped CSS may only recolor. It may not use `@import`, `@font-face`, `url()` or other things that load a file.
5. Open the pull request with the page address and a before and after picture. Do not post private pages.

Before you add a fix, ask whether the problem is a pattern that three sites share. If so, the engine should change instead.

Fixes never run code. A site list also has a dark-site file, `data-src/dark-sites.json`, for hosts that are dark by default.

## Speed rules

A dark mode runs on every page a person opens, so a small cost becomes a large one. The maintainer keeps budgets for them and checks them on every change.

- **P-01.** A page where Tintly is off pays almost nothing. The extra script time on such a page has a small budget.
- **P-02a.** The size of the content scripts that every page loads is capped. New code that a page needs only sometimes belongs in an on-demand part, loaded when the gate asks for it.
- **P-02t.** The compile and run time of the files that an empty page loads is capped, at normal speed and with the processor slowed down.
- Work is split into short slices. Never read layout in the hot path. Never touch `Function.prototype.toString`, `Error.prepareStackTrace` or other built-ins that a page can see.
- No timers or polling while a page is idle. Use observers.

If your change adds work to a page, say how much and how you measured it. Do not call a slowdown noise without a repeat run.

## Privacy and permission changes

These need an issue first.

- A new permission or host.
- A new network request, or a request to a new address.
- A new storage key, or a change to what is stored.
- Anything that reads more of a page than its styles and pictures.
- Analytics, remote code or a third-party service. These are not accepted.

If a change is accepted, the same pull request updates [docs/PRIVACY.md](../docs/PRIVACY.md). The maintainer's checks fail when a declared permission is unused or has no row there.

Storage keys and message names are a contract. People have data under those names. A rename needs a migration.

## Interface text and languages

Tintly ships in 17 languages, one file each in `extension/shared/locales/`. English (`en.js`) is the source. Persian, Arabic and Hebrew are right to left. Every file must stay complete.

**Change a text.**

1. Add or change the key in `extension/shared/locales/en.js`. English is the source.
2. Add the same key to every other file in `extension/shared/locales/`.
3. Keep every `{placeholder}` exactly as it is in English.
4. Use the key in code with `t('key')` or `data-i18n`. Show text with `textContent`.

The maintainer's checks fail on a missing key, an extra key, an empty value, a changed placeholder, a key used in code but missing in English, and a key that no code uses.

**Add a language.**

1. Add `extension/shared/locales/<code>.js` with every key of `en.js`.
2. Add one line to the `LOADERS` list in `extension/shared/i18n.js`. If the language is written right to left, add its code to `RTL_LOCALES` in the same file.
3. Add `extension/_locales/<code>/messages.json` with the same keys as `en` (name, description and shortcut labels). Use the browser's folder naming.
4. Open the popup and the settings page in the new language and look at every text. For a right-to-left language check that the layout mirrors. The styles use logical properties (`margin-inline-start`, not `margin-left`), and the maintainer's checks fail on physical ones.
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
| `dependencies` | Dependency updates |

## Pull request checklist

The pull request template has the same list.

- [ ] The change is focused and the description says why it is needed.
- [ ] A fix for a page describes the pattern with a small page and does not name a site in engine code.
- [ ] I tried the change in a real browser, including a failure case.
- [ ] No new permission, host, network request or storage key, or it was agreed in an issue first.
- [ ] I did not change the version. The maintainer raises it.
- [ ] Interface text is in every language file with the same placeholders.
- [ ] It works with the keyboard and in a right-to-left language.
- [ ] If I touched the engine, the gate or the manifest, I said how the change affects page speed.
- [ ] `CHANGELOG.md` and the docs are updated if a user can see the change.
- [ ] Screenshots and test files contain no private data.
- [ ] I wrote this change or I have the right to submit it under the MIT License.

## Security

Do not open a public issue for a security problem. Follow [SECURITY.md](SECURITY.md) and use the private vulnerability report.

## Decisions and releases

Tintly is maintained by [Ehsan Enaloo](https://github.com/ehsanenaloo). The maintainer makes the final call on what is merged, using the project rules above and the results of the private checks and tests. A "no" to a feature is not a judgment about you. Often the idea needs a permission or a service that this project does not want. You are always free to fork the project under the MIT License.

Releases are made by the maintainer. The version is raised, the changelog gets a section, the Chrome and Edge package and the Firefox package are built, and both are uploaded to the browser stores. Tintly is live in the Chrome Web Store, Edge Add-ons and Firefox Add-ons.

## License

Tintly is released under the [MIT License](../LICENSE). By opening a pull request you confirm that you wrote the change, or that you have the right to submit it under that license. No sign-off line is needed.
