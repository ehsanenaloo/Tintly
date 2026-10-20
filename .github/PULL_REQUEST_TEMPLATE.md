## Summary

<!-- What does this change and why? Keep it to one topic. -->

## Related issue

<!-- For example "Fixes #123". For a small typo or fix, write "None". -->

## Type of change

- [ ] Bug fix
- [ ] Engine fix for a page pattern (with a fixture and a test)
- [ ] Site fix data
- [ ] New feature
- [ ] Translation
- [ ] Documentation
- [ ] Maintenance or CI

## How I tested it

<!-- Browser and version, the steps you followed, what you saw, and one failure case.
Say what you ran, such as `npm run check` or `npm run test:browser`, and what you tried by hand.
For a change to the engine, the gate or the manifest, add the result of `npm run test:perf` before and after. -->

## Screenshots

<!-- Optional. Before and after for visible changes, in a light and a dark look. Do not show private pages. -->

## Translations only

<!-- Language and screens checked. Say whether you are a native speaker, fluent, or used a tool and checked it yourself. -->

## Checklist

- [ ] `npm run check` passes
- [ ] I added or updated a test, or I explained why the change cannot be tested
- [ ] The change is focused and does one thing
- [ ] A fix for a page rebuilds the pattern in a fixture, and engine code names no site or host
- [ ] I tried the change in a real browser, including a failure case (or I explained why not)
- [ ] No new permission, host, network request or storage key (or it was agreed in an issue first)
- [ ] The version was raised if I changed `extension/`
- [ ] Interface text is in all four language files with the same placeholders
- [ ] The change works with the keyboard and in a right-to-left language
- [ ] I checked the speed budgets if I touched the engine, the gate or the manifest
- [ ] `CHANGELOG.md` and the docs are updated if a user can see the change
- [ ] `docs/PRIVACY.md` is updated if data handling or permissions changed
- [ ] Screenshots and test files contain no private data
- [ ] I wrote this change or I have the right to submit it under the MIT License
