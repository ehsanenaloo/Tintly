import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMenu, MENU_ID } from '../../extension/background/modules/commands.js';

test('the menu API is looked up at each refresh: it is made once the permission exists in a running worker', async () => {
  const made = [];
  let api;
  const menu = createMenu({
    contextMenus: () => api,
    permissions: { contains: async () => true },
    title: () => 'Toggle',
  });
  assert.equal(await menu.refresh(true), false, 'no API yet: nothing is made and nothing throws');
  api = { removeAll: async () => {}, create: (d) => made.push(d) };
  assert.equal(await menu.refresh(true), true);
  assert.deepEqual(made.map((d) => d.id), [MENU_ID]);
});
