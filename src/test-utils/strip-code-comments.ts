/**
 * Strip comments from source text for the call-site ledgers, so prose (or a commented-out call) that
 * quotes a call is not counted as one. Deliberately not a parser.
 *
 * Only a block comment that OPENS its line is removed: a `/*` inside a string ('apps/*\/src') must
 * not swallow the code after it. Code after a closing `*\/` on the same line is kept, whether that
 * line opened the comment or closed one opened on an earlier line. A trailing comment after code is
 * kept, which can only over-count.
 */
export const stripCodeComments = (text: string) =>
  text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .map((line) => {
      if (/^\s*\/\//.test(line)) return '';
      if (!/^\s*\*/.test(line)) return line;
      const close = line.lastIndexOf('*/');
      return close === -1 ? '' : line.slice(close + 2);
    })
    .join('\n');
