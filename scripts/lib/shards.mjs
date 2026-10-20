// Splits test files into balanced groups. The weight is any number per file (the size, or a measured time); the heaviest
// file goes to the lightest group, so the groups end close to equal.

/**
 * @param {{ file: string, weight: number }[]} items
 * @param {number} count number of groups
 * @returns {string[][]} groups of file names, empty groups left out, each group sorted by name
 */
export function splitShards(items, count) {
  const n = Math.max(1, Math.min(Math.floor(count) || 1, items.length || 1));
  const groups = Array.from({ length: n }, () => ({ weight: 0, files: /** @type {string[]} */ ([]) }));
  const sorted = [...items].sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const item of sorted) {
    const lightest = groups.reduce((m, g) => (g.weight < m.weight ? g : m), groups[0]);
    lightest.weight += item.weight;
    lightest.files.push(item.file);
  }
  return groups.filter((g) => g.files.length).map((g) => g.files.sort());
}
