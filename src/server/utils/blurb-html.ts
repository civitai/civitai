import { Parser } from 'htmlparser2';

export type BlurbSpan = {
  blurbId: number;
  /** Index of the first character of the span's inner HTML. */
  innerStart: number;
  /** Index one past the last character of the span's inner HTML. */
  innerEnd: number;
  /** Index of the opening `<`. */
  outerStart: number;
  /** Index one past the closing `>`. */
  outerEnd: number;
};

// Positions rather than a parsed tree, because the caller splices the ORIGINAL
// string. Re-serialising a parsed document would normalise markup we never
// touched, across every entity the fan-out rewrites.
export function findBlurbSpans(html: string): BlurbSpan[] {
  const found: BlurbSpan[] = [];
  const open: Array<{ blurbId: number; outerStart: number; innerStart: number; depth: number }> =
    [];
  let depth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth++;
        if (name !== 'span') return;
        if (attribs['data-type'] !== 'blurb') return;
        const raw = attribs['data-id'];
        if (!raw || !/^\d{1,9}$/.test(raw)) return;
        open.push({
          blurbId: Number(raw),
          outerStart: parser.startIndex,
          innerStart: parser.endIndex + 1,
          depth,
        });
      },
      onclosetag(name) {
        const top = open[open.length - 1];
        if (name === 'span' && top && top.depth === depth) {
          open.pop();
          found.push({
            blurbId: top.blurbId,
            innerStart: top.innerStart,
            innerEnd: parser.startIndex,
            outerStart: top.outerStart,
            outerEnd: parser.endIndex + 1,
          });
        }
        depth--;
      },
    },
    { decodeEntities: false, recognizeSelfClosing: true }
  );

  parser.write(html);
  parser.end();

  return found.sort((a, b) => a.outerStart - b.outerStart);
}

function spliceAll(html: string, edits: Array<{ start: number; end: number; text: string }>) {
  if (!edits.length) return html;
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const edit of ordered) {
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

export function replaceBlurbSpans(html: string, contentByBlurbId: Map<number, string>): string {
  const edits = findBlurbSpans(html)
    .filter((s) => contentByBlurbId.has(s.blurbId))
    .map((s) => ({
      start: s.innerStart,
      end: s.innerEnd,
      text: contentByBlurbId.get(s.blurbId) as string,
    }));
  return spliceAll(html, edits);
}

export function unwrapBlurbSpans(html: string, blurbIds: Set<number>): string {
  const edits = findBlurbSpans(html)
    .filter((s) => blurbIds.has(s.blurbId))
    .map((s) => ({
      start: s.outerStart,
      end: s.outerEnd,
      text: html.slice(s.innerStart, s.innerEnd),
    }));
  return spliceAll(html, edits);
}

export function renderBlurbSpan(blurbId: number, content: string): string {
  return `<span data-type="blurb" data-id="${blurbId}">${content}</span>`;
}
