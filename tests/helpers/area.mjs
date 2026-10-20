/** An in-memory storage area. With `quota` it enforces the `storage.sync` limits. */
export function fakeArea({ quota = false } = {}) {
  /** @type {Record<string, any>} */
  let data = {};
  const bytes = (key, value) => key.length + Buffer.byteLength(JSON.stringify(value));
  return {
    peek: () => structuredClone(data),
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      const next = { ...data, ...structuredClone(items) };
      if (quota) {
        let total = 0;
        for (const [k, v] of Object.entries(next)) {
          const size = bytes(k, v);
          if (size > 8192) throw new Error(`QUOTA_BYTES_PER_ITEM exceeded by ${k}`);
          total += size;
        }
        if (total > 102_400) throw new Error('QUOTA_BYTES exceeded');
        if (Object.keys(next).length > 512) throw new Error('MAX_ITEMS exceeded');
      }
      data = next;
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}
