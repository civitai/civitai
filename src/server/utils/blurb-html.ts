import { Parser } from 'htmlparser2';
import { isBlurbId } from '~/shared/constants/blurb.constants';
import { sanitizeBlurbInterior } from '~/utils/html-sanitize-helpers';

/** `innerEnd`/`outerEnd` are exclusive — one past the last character. */
export type BlurbSpan = {
  blurbId: number;
  innerStart: number;
  innerEnd: number;
  outerStart: number;
  outerEnd: number;
};

// Positions rather than a parsed tree, because the caller splices the ORIGINAL
// string. Re-serialising a parsed document would normalise markup we never
// touched, across every entity the fan-out rewrites.
export function findBlurbSpans(html: string): BlurbSpan[] {
  const found: BlurbSpan[] = [];
  const open: Array<{
    blurbId: number;
    outerStart: number;
    innerStart: number;
    depth: number;
  }> = [];
  let depth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth++;
        if (name !== 'div') return;
        if (attribs['data-type'] !== 'blurb') return;
        const raw = attribs['data-id'];
        if (!isBlurbId(raw)) return;
        const blurbId = Number(raw);
        open.push({
          blurbId,
          outerStart: parser.startIndex,
          innerStart: parser.endIndex + 1,
          depth,
        });
      },
      onclosetag(name) {
        const top = open[open.length - 1];
        // Both clauses matter: the interior carries other tags, and it can nest plain `div`s.
        if (top && name === 'div' && top.depth === depth) {
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
    // Both clauses drop an edit rather than corrupt the output. Positions all come from one scan
    // of the original string, so an edit nested inside one already applied has a stale range
    // (`start < cursor`); and a self-closing `<div data-type="blurb"/>` reports its inner end
    // before its inner start (`end < start`).
    if (edit.end < edit.start || edit.start < cursor) continue;
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

/**
 * The interior sanitize lives at this splice, not at either caller, because both materialisation
 * paths — `expandBlurbs` on save and the fan-out's rewrite — land here. `blurbContentSchema`
 * already sanitizes anything written through the API; this covers a row that was not (a backfill,
 * an admin script), which is the only path by which a nested blurb or a `data-type` on an interior
 * span could reach a host body — see the note on BLURB_INTERIOR_ALLOWED_TAGS. Only the inserted
 * text is sanitized; the host document is still spliced by position and never re-serialised.
 */
export function replaceBlurbSpans(html: string, contentByBlurbId: Map<number, string>): string {
  const edits = findBlurbSpans(html)
    .filter((s) => contentByBlurbId.has(s.blurbId))
    .map((s) => ({
      start: s.innerStart,
      end: s.innerEnd,
      text: sanitizeBlurbInterior(contentByBlurbId.get(s.blurbId) as string),
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
  return `<div data-type="blurb" data-id="${blurbId}">${content}</div>`;
}
