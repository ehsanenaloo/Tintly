# Architecture

This is an overview of how Tintly is built. The code in `extension/` is the final word. If this page and the code disagree, the code is right.

Tintly has no build step. The folder `extension/` is the extension exactly as it ships: plain JavaScript, HTML, CSS and JSON. Chrome and Edge use one package. The Firefox package comes from the same folder, with a generated manifest.

## Parts

```text
                    extension storage  (settings, site rules, presets, fixes, interface state)
                                 ^   ^
                                 |   |  read, change events
   +-----------+   messages  +---+---+-----------+   messages   +----------------------------+
   | toolbar   |<----------->| service worker     |<------------>| content script, per frame   |
   | settings  |             | state, icon, keys, |  site data,  | gate -> engine (isolated)   |
   | fix editor|             | data, net proxy    |  net proxy   +--------------+-------------+
   +-----------+             +--------------------+                             ^ events only
                                                                  +-------------+-------------+
                                                                  | page-world hook (tiny)    |
                                                                  +---------------------------+
```

The parts share data only through extension storage and a small set of validated messages.

### Service worker

`extension/background/service-worker.js` and its modules.

- It is the only writer of settings. Writes go through one queue, and each write is checked against the settings schema.
- It keeps no state that cannot be rebuilt. A restart loses nothing.
- It answers messages after checking the sender and the shape of the payload.
- It serves the site data (fixes and the dark-site list) for one host at a time. A page never receives the whole data set.
- It is the network proxy for style sheets and pictures that the page code cannot read itself, with size, time and address limits. This is the only network use of the extension.
- It owns the toolbar icon, the keyboard shortcuts and the optional context menu.
- It registers the content scripts with the scripting API for the pages where Tintly can be on, keeps the registration equal to the settings, and puts the files into tabs that are already open. A page that is switched off gets no script from Tintly.
- With the optional `alarms` permission and a schedule by hours or by sun times, it wakes at the start and end of the schedule so the registration follows the clock.

### Content script

`extension/content/`, classic scripts in the isolated world, in all frames, at `document_start`.

1. `core/namespace.js` creates the single namespace `globalThis.__dk`. Every other content file adds its parts to it.
2. `core/prefetch.js` starts the read of settings at once, before the other files are parsed.
3. The other files that every page needs for its first paint.
4. `core/boot.js`, the gate. It waits for the settings read and decides for the host. If the site is off it does nothing else and returns. If the site is on it starts the engine, whose first action is an early style: a dark canvas.

Parts that a page needs only sometimes are not in the registered list. The worker injects them into the same isolated world when the gate asks for them, from a fixed list of names (for example picture analysis, shadow roots, the site's own dark theme and the E-ink palette). `core/loader.js` is the page side. If a part fails to load, the engine goes on without it.

The content script is the only part that touches the DOM of the page. It treats everything from the page as hostile input.

### Page-world hook

`extension/content/main-world/hook.js` runs in the JavaScript world of the page. It has one job: report changes that the isolated script cannot see. These are shadow roots being attached (also closed ones), constructed style sheets being adopted and changed, and rules added or removed through the CSS object model. It wraps a few built-in methods with proxies that call the original first and return or throw exactly what it did. It exposes no API and sends only DOM events, which the isolated script treats as untrusted hints.

### Pages

`extension/pages/`, ES modules.

- `popup/` is the toolbar window.
- `options/` is the settings page, opened in a tab.
- `fixes/` is the fix editor with a live preview and an element picker.

All pages share `shared/` code: settings, storage, languages, limits, schedule math and site matching. They render text with `textContent` only.

## Engines

The engine is the way a page is colored. The default, Automatic, uses Dynamic.

| Engine | How it works |
| --- | --- |
| Dynamic | Finds the style sheets of the page, writes a copy of each with new colors in short slices, and watches for sheets and elements that are added later. Best result. |
| Filter | Inverts the whole page with one filter and puts pictures back. It needs no style sheet reading and starts at once. |
| Filter+ | Like Filter, with colors taken from the chosen theme. |
| Static | Colors only the parts that a stored fix names, with a background, a text and a border color. |

The Filter engines cannot tell a dark page from a light one. In the Light mode they do not invert. A page whose style sheet cannot be fetched is colored with Filter+ if it stays light.

Around the engines there are:

- **Detection.** A page that is already dark is left as it is. A page that declares `color-scheme: only light` or `only dark` is respected. A page that has a dark theme of its own can have it switched on, and Tintly checks the result before it keeps it.
- **Pictures.** On a dark page, dark logos and charts on white are inverted, very bright photos are dimmed, and a few kinds (QR codes, flags) are left alone.
- **Readability.** After a page is colored, text that is still hard to read gets a readable color. Text on pictures, text you type and pages that Tintly leaves alone are not changed.
- **Paper and E-ink.** Extra rules for the reading modes: paper color, ink, gray levels, flattened gradients and no motion.
- **Failure rules.** An error in an entry point stops the engine for that frame and removes what it added. The page keeps running. Repeated faults on one host put it in a safe mode.

## Data flow for one page load

1. The browser starts the frame. The hook and the gate run before any page script.
2. The gate reads settings and the site data for its host and decides. If the site is off, it returns. The cost is one storage read and a few comparisons.
3. If the site is on, the early style sets a dark background and the scheme hint, and the gate asks the worker for the fixes of the host.
4. The chosen engine starts. Dynamic discovers sheets, rewrites them in slices and observes changes.
5. Detection may find that the page is already dark and ask the engine to stand down.
6. The top frame reports its state to the worker, so the toolbar icon is right.
7. A settings change reaches open tabs through storage events. A running Dynamic engine is replaced by a staged one that shows the quick version of the new look at once and takes over in one task.

## Naming

- Elements added to a page use the prefix `dk-`: ids `dk-*`, attributes `data-dk-*`, custom properties `--dk-*`. A page that is switched off keeps none of them.
- The namespace in content scripts is `globalThis.__dk`. No other global is created.
- Message types are named `dk.<area>.<action>`.

## Security and privacy rules in the code

- Text is shown with `textContent`. The static checks fail on `innerHTML`, `eval`, `new Function`, inline event handlers, `importScripts`, workers and similar.
- Extension pages have a strict content security policy.
- Imported settings, sync data and site fixes are checked against limits and schemas. Custom CSS that comes from a file or from sync stays off until the user turns it on.
- The network proxy refuses addresses on private networks and applies size and time limits.
- There is no analytics and no remote configuration or code.

More: [PRIVACY.md](PRIVACY.md) and [TESTING.md](TESTING.md).
