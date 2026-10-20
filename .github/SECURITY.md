# Security Policy

## Supported versions

Tintly is in development and has no store release yet. Security fixes are made to the latest code on the `main` branch and, once there are releases, to the latest release. Older versions are not patched. Please update before you report.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately with the private vulnerability reporting of GitHub:

1. Go to the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe the problem and how to repeat it.

Direct link: <https://github.com/ehsanenaloo/Tintly/security/advisories/new>

Helpful details:

- the extension version, the browser and its version, and your operating system,
- the part that is affected (the engine in a page, the service worker, the toolbar window, the settings page, the fix editor, import, sync),
- a small page or a file that shows the problem,
- clear steps to repeat it,
- the impact you believe it has.

Please do not include passwords, session cookies, tokens or other private data in a report.

## What to expect

This is a volunteer project, so replies are best effort. The maintainer will acknowledge a report, assess it, work on a fix for a confirmed problem and credit you in the release notes if you wish. Please allow a reasonable time to ship a fix before you tell anyone else.

## Scope

In scope:

- code in this repository that ships in the extension,
- ways to make Tintly read, change, store or send more than its documented permissions and behavior allow (see [docs/PRIVACY.md](../docs/PRIVACY.md)),
- ways for a web page, a style sheet or a picture to make the extension run code, fetch an address it should not (for example a private network address), or act on a site that is switched off,
- injection or script execution through page text, stored settings, imported settings files, sync data, fixes, custom CSS or translated strings,
- ways to make custom CSS from a file or from sync run without the user turning it on,
- anything that exposes data from one page to another page or to a third party.

Out of scope:

- problems that need an already compromised browser, operating system or browser profile,
- bugs in Chrome, Edge or Firefox, or in other extensions,
- findings that depend on a modified copy of the extension,
- a page that looks wrong or runs slowly (use the [issue forms](https://github.com/ehsanenaloo/Tintly/issues/new/choose)),
- social engineering.

## Design notes for researchers

- Permissions are `storage` and `scripting`, access to all sites, and the optional `contextMenus` and `alarms`. See [docs/PRIVACY.md](../docs/PRIVACY.md). In Firefox `menus` and `alarms` are part of the package because Firefox does not offer them as optional.
- The extension makes no network request of its own except to fetch the style sheets and pictures of the page the user is on. It has no analytics, no account and no remote configuration, and it loads no remote code.
- Extension pages have a strict content security policy. Text from pages, settings and translations is shown as text, never as HTML.
- Custom CSS that comes from an imported file or from sync stays off until the user reads it and turns it on.
- The service worker checks the sender and the shape of every message.
