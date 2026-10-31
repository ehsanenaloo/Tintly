// @ts-check
// Orders the writes to one record when a write may be tried again. A try that comes after a newer write on the same key started
// is not made, so a late retry never reverses a newer edit or brings back a deleted record.

/**
 * @returns {{
 *   begin: (key: string) => number,
 *   current: (key: string, id: number) => boolean,
 *   guard: (key: string, id: number, send: () => Promise<any>) => () => Promise<any>,
 * }}
 */
export function createWriteOrder() {
  /** @type {Map<string, number>} */
  const latest = new Map();
  let count = 0;
  return {
    /** Start a write on a key; every older write on it is now stale. */
    begin(key) {
      const id = ++count;
      latest.set(key, id);
      return id;
    },
    /** Is this still the newest write on the key? An answer to an older one must not change what the newer one tracks. */
    current(key, id) {
      return latest.get(key) === id;
    },
    /** A send that gives up with the code `superseded` when a newer write started. */
    guard(key, id, send) {
      return () => (latest.get(key) === id ? send() : Promise.resolve({ ok: false, code: 'superseded' }));
    },
  };
}
