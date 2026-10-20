// A small driver for the installed Firefox, over WebDriver BiDi. It loads the Firefox build of the extension as a
// temporary add-on in a fresh profile, so the user's own Firefox and profile are never touched.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { writePackage } from '../../scripts/lib/package-files.mjs';
import { readZip } from '../../scripts/lib/zip.mjs';

const UUID = '5f0d3f1e-6a3c-4c52-9a14-3f6b1f0e7a11';

/** The Firefox program: DK_FIREFOX, else the usual place of the system. */
function firefoxPath() {
  if (process.env.DK_FIREFOX) return process.env.DK_FIREFOX;
  if (process.platform === 'win32') return 'C:/Program Files/Mozilla Firefox/firefox.exe';
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  return 'firefox';
}

export function firefoxAvailable() {
  const path = firefoxPath();
  if (path.includes('/') || path.includes('\\')) return existsSync(path);
  return spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * The `skip` option of the Firefox tests. A machine without Firefox skips them; in CI (CI is set) a missing Firefox is
 * a failure, so a green run never means the tests did not run.
 */
export function firefoxSkip({ installed = firefoxAvailable(), ci = Boolean(process.env.CI) } = {}) {
  if (installed || ci) return false;
  return 'Firefox is not installed';
}

/** Build the Firefox package and unpack it into a folder. */
function unpackBuild() {
  const out = mkdtempSync(join(tmpdir(), 'dk-ff-dist-'));
  try {
    const { file } = writePackage('firefox', join(REPO, 'extension'), out);
    const dir = mkdtempSync(join(tmpdir(), 'dk-ff-ext-'));
    for (const { name, data } of readZip(readFileSync(file))) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), data);
    }
    return dir;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The port Firefox listens on for WebDriver BiDi, read from its startup output. */
export async function debugPort(child, profile, timeoutMs = 30000) {
  let output = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const fromOutput = () => /WebDriver BiDi listening on ws:\/\/[^\s:]+:(\d+)/.exec(output)?.[1];
  const fromFile = () => {
    try {
      return String(JSON.parse(readFileSync(join(profile, 'WebDriverBiDiServer.json'), 'utf8')).ws_port || '') || undefined;
    } catch {
      return undefined;
    }
  };
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const port = fromOutput() ?? fromFile();
    if (port) return Number(port);
    if (child.exitCode !== null) throw new Error(`Firefox exited before it opened the BiDi port (code ${child.exitCode}): ${output.slice(-500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`Firefox did not report a BiDi port: ${output.slice(-500)}`);
}

/** @param {{ prefs?: Record<string, string | number | boolean> }} [options]  extra preferences of the test profile */
export async function startFirefox(options = {}) {
  const extDir = unpackBuild();
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  const geckoId = manifest.browser_specific_settings.gecko.id;
  // Test copy only: let a local page hold an extension page in a frame, because the driver cannot open one directly.
  manifest.web_accessible_resources = [{ resources: ['pages/*', 'shared/*'], matches: ['http://127.0.0.1/*'] }];
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("; frame-ancestors 'none'", '');
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const profile = mkdtempSync(join(tmpdir(), 'dk-ff-profile-'));
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [geckoId]: UUID }))});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("app.update.enabled", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("startup.homepage_welcome_url", "about:blank");',
      'user_pref("browser.tabs.warnOnClose", false);',
      ...Object.entries(options.prefs ?? {}).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
      '',
    ].join('\n'),
  );
  // Port 0 lets Firefox pick a free port; it reports the real one on stderr (and in a file of the profile).
  if (!firefoxAvailable()) throw new Error(`Firefox was not found at ${firefoxPath()}; set DK_FIREFOX`);
  const child = spawn(firefoxPath(), ['-profile', profile, '-no-remote', '-headless', '--remote-debugging-port=0', '--remote-allow-system-access'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await debugPort(child, profile);

  let socket;
  for (let i = 0; i < 100 && !socket; i++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error('no socket'));
      });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!socket) {
    child.kill();
    throw new Error('Firefox did not open the BiDi port');
  }

  let nextId = 1;
  const waiting = new Map();
  const events = [];
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.type === 'error') reject(new Error(`${msg.error}: ${msg.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const session = await call('session.new', { capabilities: { alwaysMatch: {} } });
  const installed = await call('webExtension.install', { extensionData: { type: 'path', path: extDir } });
  const origin = `moz-extension://${UUID}`;

  /** Open a new tab and return its context id. */
  async function newTab(url) {
    const { context } = await call('browsingContext.create', { type: 'tab' });
    if (url) await call('browsingContext.navigate', { context, url, wait: 'complete' });
    return context;
  }

  /** Open an extension page inside a frame of a local page; returns the context of the frame. */
  async function extensionPage(serverOrigin, path) {
    const tab = await newTab(`${serverOrigin}/gen/frame.html?src=${encodeURIComponent(`${origin}${path}`)}`);
    for (let i = 0; i < 50; i++) {
      const tree = await call('browsingContext.getTree', { root: tab });
      const child = tree.contexts[0]?.children?.[0];
      if (child && child.url.startsWith('moz-extension://')) return { tab, frame: child.context };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the extension frame did not load');
  }

  /**
   * Open an extension page as its own tab, the way a browser shows it: `tabs` and `storage.session` exist there, and they
   * do not in a frame of a web page. A frame page opens it; returns its context.
   */
  async function extensionTab(serverOrigin, path) {
    const { frame } = await extensionPage(serverOrigin, '/pages/options/options.html');
    const known = new Set((await call('browsingContext.getTree', {})).contexts.map((c) => c.context));
    await run(frame, (url) => void window.open(url), `${origin}${path}`);
    for (let i = 0; i < 50; i++) {
      const found = (await call('browsingContext.getTree', {})).contexts.find((c) => !known.has(c.context) && c.url.startsWith('moz-extension://'));
      if (found) return found.context;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the extension tab did not open');
  }

  /** A PNG of a context as a Buffer. */
  async function screenshot(context) {
    const { data } = await call('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    return Buffer.from(data, 'base64');
  }

  /** Set the viewport of a context, in CSS pixels. */
  const viewport = (context, width, height) => call('browsingContext.setViewport', { context, viewport: { width, height } });

  /** Run a function in the page (or extension page) of a context and get its JSON-able result. */
  async function run(context, fn, ...args) {
    const expression = `(async () => JSON.stringify(await (${fn.toString()})(...${JSON.stringify(args)})))()`;
    const r = await call('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' });
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text ?? 'script error');
    return r.result.type === 'undefined' ? undefined : JSON.parse(r.result.value);
  }

  return {
    session,
    installed,
    origin,
    call,
    newTab,
    extensionPage,
    extensionTab,
    screenshot,
    viewport,
    run,
    events,
    version: session.capabilities?.browserVersion,
    async close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
      // Firefox runs helper processes that keep the profile open: end the whole tree, then wait for the exit.
      const exited = child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r));
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      // The files are temporary: a folder that cannot be removed yet is not a failed test.
      for (const dir of [profile, extDir]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch {
          // left to the system's temporary folder cleanup
        }
      }
    },
  };
}
