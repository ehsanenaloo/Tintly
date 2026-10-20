# Translating Tintly

Tintly shows its windows in Persian (`fa`), English (`en`), Arabic (`ar`) and Hebrew (`he`). Persian, Arabic and Hebrew are written right to left, and the whole window mirrors.

## Status of the translations

English is the source. Tests check that the translation files are complete and consistent. They cannot judge wording, tone or fit, so a native reader is the best judge. Reports of wrong or awkward text are welcome.

## Two kinds of text

| Text | Files | Used for |
| --- | --- | --- |
| Browser strings | `extension/_locales/<code>/messages.json` | The name, the store description, the shortcut labels and the context menu item. The browser reads them before any script runs. |
| Interface strings | `extension/shared/locales/<code>.js` | Everything inside the toolbar window, the settings page and the fix editor. |

An interface string is a message with `{placeholder}` markers, or a set of plural forms chosen by the number. English is the fallback, so a missing key shows English.

## Fix a wrong text

1. Find the text in `extension/shared/locales/en.js` to get its key, then find the same key in your language file.
2. Change the value only. Keep the key, every `{placeholder}` and the plural structure.
3. Run `npm run check`. It fails if a file is incomplete or a placeholder changed.
4. Open a pull request. Name the screen where you saw the text, and say whether you are a native speaker, fluent, or used a tool and checked the result yourself.

If you do not want to edit files, open a [translation fix issue](https://github.com/ehsanenaloo/Tintly/issues/new?template=translation_fix.yml) with the current text and your suggestion.

## Add a language

Open an issue first, so we can agree on the language code. Then:

1. Add `extension/shared/locales/<code>.js` with every key of `en.js`. Give each plural entry the forms your language needs. `node -e "console.log(new Intl.PluralRules('<code>').resolvedOptions().pluralCategories)"` lists them.
2. Add one line to `LOADERS` in `extension/shared/i18n.js`. For a right-to-left language, add the code to `RTL_LOCALES` in the same file.
3. Add `extension/_locales/<code>/messages.json` with the same keys as English. Use the browser's folder names (`pt_BR`, not `pt-BR`).
4. Run `npm run check`.
5. Load the extension, choose the language in the settings, and look at the toolbar window, every settings tab and the fix editor. Look for cut-off text, overlaps and icons that point the wrong way.
6. Say in the pull request whether you are a native speaker, fluent, or used a tool and checked the result.

## Writing rules

- Use natural words for the people who speak the language. Do not translate word by word.
- Keep the same meaning. Do not drop a warning.
- Use one word for one idea across the whole interface.
- Keep product terms (Tintly, E-ink, Paper) and the names of browser features as they are.
- Write each sentence as one message. Do not join translated pieces.
- Persian: simple modern Persian, correct half-space, Persian punctuation.

## What the tests cannot judge

Quality, tone, terms, and fit in a narrow window. Look at the real windows in your language, in the light and the dark look, and at a narrow width. For a right-to-left language, check that the layout mirrors.
