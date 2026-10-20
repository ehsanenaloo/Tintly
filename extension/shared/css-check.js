// @ts-check

/** A rough check that finds the mistakes that break the rest of a style sheet: an open brace, quote or comment. */
export function cssProblem(/** @type {string} */ text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return true;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== c) return true;
      i = j;
    } else if (c === '\\') {
      i += 1;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}
