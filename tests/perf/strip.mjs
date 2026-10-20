// Source size without comments, for the size rows of the performance harness. A comment costs a few cycles of the scanner and no
// compile work, so the bytes that follow the cost of a file are the bytes of its code. The files stay as they are: nothing is
// minified. Only comments are left out of the count, and lines that hold nothing else.

const REGEX_BEFORE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isIdentChar = (c) => /[\w$]/.test(c);

/**
 * The source with every comment removed. Strings, template literals (with nested `${}`) and regular expression literals are
 * kept whole. A regular expression is told from a division by the token before the slash.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  /** The last token that is not a comment or white space: 'ident', 'number', a closing bracket, or the punctuator itself. */
  let prev = '';
  let prevWord = '';
  /** One entry for each open `${`: the depth of braces inside it. */
  const templates = [];
  let braces = 0;

  const regexAllowed = () => {
    if (prev === '') return true;
    if (prev === 'ident') return REGEX_BEFORE.has(prevWord);
    if (prev === 'number' || prev === ')' || prev === ']' || prev === '}') return false;
    return true;
  };

  /** Copy a template literal from the character after the opening quote until `${` or the closing quote. */
  const template = () => {
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        out += c;
        i++;
        prev = 'string';
        return;
      } else if (c === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        templates.push(braces);
        braces = 0;
        prev = '{';
        return;
      } else {
        out += c;
        i++;
      }
    }
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      // A comment that spans lines leaves one line break, so a statement does not run into the next one.
      if (source.slice(i, stop).includes('\n')) out += '\n';
      else out += ' ';
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = 'string';
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      template();
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && isIdentChar(source[j])) j++;
      out += source.slice(i, j);
      i = j;
      prev = 'string';
      continue;
    }
    if (c === '{') {
      braces++;
      prev = '{';
    } else if (c === '}') {
      if (templates.length && braces === 0) {
        braces = /** @type {number} */ (templates.pop());
        out += c;
        i++;
        template();
        continue;
      }
      braces--;
      prev = '}';
    } else if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    } else if (isIdentChar(c)) {
      let j = i;
      while (j < n && isIdentChar(source[j])) j++;
      const word = source.slice(i, j);
      out += word;
      i = j;
      prev = /^\d/.test(word) ? 'number' : 'ident';
      prevWord = word;
      continue;
    } else if (c === '.' && /\d/.test(d ?? '')) {
      prev = 'number';
    } else {
      prev = c;
    }
    out += c;
    i++;
  }
  return out;
}

/** Bytes of the code of a file: LF line ends, no comments, no trailing white space, no blank lines. @param {string | Buffer} source */
export function codeBytes(source) {
  const text = stripComments(String(source).replace(/\r\n?/g, '\n'));
  return Buffer.byteLength(
    text
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line !== '')
      .join('\n'),
  );
}
