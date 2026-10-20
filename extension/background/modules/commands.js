// @ts-check
// Keyboard shortcuts and the context menu item.

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
        default:
          return { ok: false, code: 'unknown' };
      }
    },
  };
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
