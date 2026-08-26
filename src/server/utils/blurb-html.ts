import { Parser } from 'htmlparser2';
import { sanitizeBlurbInterior } from '~/utils/html-sanitize-helpers';

export type BlurbSpan = {
  blurbId: number;
  innerStart: number;
  /** Index one past the last character of the span's inner HTML. */
  innerEnd: number;
  outerStart: number;
  /** Index one past the closing `>`. */
  outerEnd: number;
};

// Bounded by int4's max, since Blurb.id is a SERIAL column — this is the
// widest value the id could ever legitimately be.
const MAX_BLURB_ID = 2_147_483_647;

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
        if (!raw || !/^\d+$/.test(raw)) return;
        const blurbId = Number(raw);
        if (blurbId > MAX_BLURB_ID) return;
        open.push({
          blurbId,
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
    // All positions come from one scan of the original string, so an edit
    // nested inside one already applied has a stale range by the time we get
    // here — apply the outer edit and drop the inner one, rather than corrupt
    // the output.
    if (edit.end < edit.start || edit.start < cursor) continue;
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

/**
 * Both paths that materialise a blurb into an entity body land here — `expandBlurbs` on save and
 * the fan-out's rewrite — which is why the interior sanitize lives at this splice rather than at
 * either caller. A rule enforced at two call sites is a rule that drifts, and drift between the
 * interactive path and the fan-out is the failure this whole feature keeps running into.
 *
 * `blurbContentSchema` already sanitizes at save, so for a row written through the API this is
 * redundant. It is here for the row that was not: a backfill, an admin script, or a row that
 * predates the schema's inline-only rule. A block element spliced inside an inline
 * `<span data-type="blurb">` is hoisted out by the browser's parser, leaving the chip empty — see
 * the note on BLURB_INTERIOR_ALLOWED_TAGS.
 *
 * Only the INSERTED text is sanitized. The host document is still spliced by position and never
 * re-serialised, which is the property the rest of this module exists to preserve.
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
  return `<span data-type="blurb" data-id="${blurbId}">${content}</span>`;
}
