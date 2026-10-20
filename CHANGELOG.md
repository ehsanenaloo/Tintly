# Changelog

All notable changes to Tintly are listed here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.11] - 2026-10-20

The first public release.

### Added

- Five modes for every web page: Dark, Light, Paper, E-ink and Original. Original keeps the page's own colors.
- Four ways to color a page: Dynamic, Filter, Filter+ and Static.
- Color vision correction for red, green or blue color weakness, with a strength from 0 to 100 percent. It moves colors that look alike apart. Pictures, video and icons follow it unless you turn that off.
- Grayscale, grayscale inverted and inverted filters in the Original mode, with Intensity and Color boost settings.
- Paper and E-ink modes for reading, with a Color setting, grayer pictures, underlined links and an option to stop animations.
- A toolbar window with the main switch, a switch for the current site, mode, engine, brightness, contrast, sepia, grayscale and presets. It can save a change for all sites or for one site.
- A choice to run on all sites or only on the sites you turn on.
- A settings page with colors, palettes, font, text stroke, scrollbar and selection colors, custom CSS, site rules, presets, import and export, optional sync and a reset.
- Schedules by hours, by sunset and sunrise at your place, or by the dark mode of your system.
- Site fixes for one site: extra CSS, elements to invert or leave alone, and style sheets to skip.
- Pages that are already dark are left alone. When a page has a dark theme of its own, Tintly can switch it on.
- A page can ask Tintly to leave it alone with a meta tag named `tintly` with the content `off`, or the attribute `data-tintly="off"`.
- Dark logos and charts are inverted, very bright photos are dimmed, and square codes keep a white plate so they can be scanned.
- Text keeps a contrast of at least 4.5 to 1, and outlines and form borders keep 3 to 1.
- Interface in English, Persian, Arabic and Hebrew, left to right and right to left, with a light and a dark look.
- The toolbar window, the settings page and the fix editor work with the keyboard.
- Links to report a problem and to suggest a feature in About. A welcome page opens once after a fresh install, and the browser opens a short survey after removal.

### Security

- Tintly makes no network request except to fetch the style sheets and pictures of the page you are on. It has no analytics, no account and no remote settings.
- Custom CSS from an imported file or from sync stays off until you read it and turn it on.
- Tintly does not follow a redirect when it reads a file of another site for the page you are on.
- Before Tintly reads a file for a page, it checks that the page really uses the file. The browser then checks the address Tintly connects to, or the page reads the file itself. So the browser's protection of your local network also covers the files Tintly reads.
