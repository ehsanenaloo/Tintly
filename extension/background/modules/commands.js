// @ts-check
// Keyboard shortcuts and the context menu item.

import { EINK_RESET } from '../../shared/settings.js';

/**
 * @param {{
 *   state: ReturnType<typeof import('./state.js').createState>,
 *   activeTab: () => Promise<{ url?: string } | undefined>,
 * }} deps
 */
export function createCommands({ state, activeTab }) {
  return {
    /** @param {string} command @param {{ url?: string } | undefined} [tab] */
    async handle(command, tab) {
      switch (command) {
        case 'toggle_extension':
          return state.toggleExtension();
        case 'toggle_site': {
          const t = tab ?? (await activeTab());
          return state.toggleSite(t?.url);
        }
        case 'switch_engine':
          return state.cycleEngine();
        case 'mode_dark':
        case 'mode_light':
        case 'mode_original':
          return state.patchSettings({ theme: { mode: command.slice(5) } });
        case 'mode_paper':
        case 'mode_eink': {
          const choice = command.slice(5);
          const read = await state.read();
          const same = read.ok && read.state.settings.theme.einkPreset === choice;
          return state.patchSettings({ theme: { mode: 'eink', einkPreset: choice, ...(same ? {} : EINK_RESET) } });
        }
        default:
          return { ok: false, code: 'unknown' };
      }
    },
  };
}

/**
 * Listen for the shortcut commands. A browser without the API (a phone browser, Firefox for Android) has none: nothing is bound and
 * the rest of the worker starts as usual. A listener that throws at the top level would stop the whole worker.
 * @param {{ onCommand?: { addListener?: (fn: (command: string, tab?: any) => void) => void } } | undefined} api
 * @param {(command: string, tab?: any) => void} onCommand
 * @returns {boolean} true when the listener is bound
 */
export function bindCommands(api, onCommand) {
  if (!api?.onCommand || typeof api.onCommand.addListener !== 'function') return false;
  api.onCommand.addListener(onCommand);
  return true;
}

export const MENU_ID = 'dk-toggle-site';

/**
 * The context menu item. It needs the optional `contextMenus` permission, which the settings page asks for when the user
 * turns the item on, so it is only made when both the setting and the permission are there.
 * @param {{
 *   contextMenus: { create(d: any): any, removeAll(): Promise<void> } | (() => { create(d: any): any, removeAll(): Promise<void> } | undefined),
 *   permissions: { contains(d: any): Promise<boolean> },
 *   title: () => string,
 *   permission?: string,
 * }} deps
 */
export function createMenu({ contextMenus, permissions, title, permission = 'contextMenus' }) {
  return {
    /** @param {boolean} wanted the `contextMenu` setting */
    async refresh(wanted) {
      let allowed = false;
      try {
        allowed = wanted && (await permissions.contains({ permissions: [permission] }));
      } catch {
        allowed = false;
      }
      try {
        const api = typeof contextMenus === 'function' ? contextMenus() : contextMenus;
        if (!api) return false;
        await api.removeAll();
        if (allowed) api.create({ id: MENU_ID, title: title(), contexts: ['page', 'action'] });
      } catch {
        // The permission was taken away while we were working.
      }
      return allowed;
    },
  };
}
