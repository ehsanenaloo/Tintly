import { startFirefox } from './driver.mjs';
import { startServers } from '../browser/harness.mjs';
const servers = await startServers();
const ff = await startFirefox();
console.log('version', ff.version);
try {
  const { frame } = await ff.extensionPage(servers.origin, '/pages/options/options.html');
  console.log(await ff.run(frame, () => document.title + ' | ' + typeof browser + ' | ' + typeof chrome + ' | ' + (document.body.hasAttribute('data-loading'))));
  console.log(JSON.stringify(await ff.run(frame, async () => { await browser.storage.local.set({ probe: 1 }); return await browser.storage.local.get(null); })).slice(0, 300));
} catch (e) { console.log('ERR', e.message); }
await ff.close();
await servers.close();
