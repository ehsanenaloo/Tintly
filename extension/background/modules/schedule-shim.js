// @ts-check
// The clock code of the page (content/core/schedule.js) adds itself to `globalThis.__dk`. This module runs first and gives it
// that object, so the worker uses the same file and the same sun and window math as the page, with no copy.
Reflect.defineProperty(globalThis, '__dk', { value: Object.create(null), configurable: true, writable: true });
