import { Parser } from 'htmlparser2';
import { namesBodyMedia } from '~/server/utils/article-body-media';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { WITHHELD_MEDIA_TYPE } from '~/shared/constants/withheld-media.constants';

/**
 * A body image the editor may not see goes to the edit form as a placeholder naming its position
 * among the stored body's media, and a save puts the stored node back in its place. The placeholder
 * carries no url or key.
 */
const placeholder = (ref: number) =>
  `<span data-type="${WITHHELD_MEDIA_TYPE}" data-id="${ref}"></span>`;

type Slice = { start: number; end: number };
type MediaSlice = Slice & { src: string };

/** Each `img` and `edge-media` in document order, with its source. */
function mediaSlices(html: string): MediaSlice[] {
  const slices: MediaSlice[] = [];
  const open: { tag: string; start: number; src: string }[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'img' && name !== 'edge-media') return;
        const src = (name === 'img' ? attribs.src : attribs.url) ?? '';
        open.push({ tag: name, start: parser.startIndex, src });
      },
      onclosetag(name) {
        if (name !== 'img' && name !== 'edge-media') return;
        const node = open.pop();
        if (node) slices.push({ start: node.start, end: parser.endIndex + 1, src: node.src });
      },
    },
    { lowerCaseTags: true, recognizeSelfClosing: true }
  );
  parser.end(html);
  return slices.sort((a, b) => a.start - b.start);
}

function placeholderSlices(html: string): (Slice & { ref: string | undefined })[] {
  const slices: (Slice & { ref: string | undefined })[] = [];
  const stack: ({ start: number; ref: string | undefined } | null)[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'span') return;
        stack.push(
          attribs['data-type'] === WITHHELD_MEDIA_TYPE
            ? { start: parser.startIndex, ref: attribs['data-id'] }
            : null
        );
      },
      onclosetag(name) {
        if (name !== 'span') return;
        const node = stack.pop();
        if (node) slices.push({ start: node.start, end: parser.endIndex + 1, ref: node.ref });
      },
    },
    { lowerCaseTags: true }
  );
  parser.end(html);
  return slices.sort((a, b) => a.start - b.start);
}

function replaceSlices(html: string, replacements: (Slice & { text: string })[]) {
  let out = '';
  let at = 0;
  for (const { start, end, text } of replacements) {
    // A slice nested in one already replaced went with it.
    if (start < at) continue;
    out += html.slice(at, start) + text;
    at = end;
  }
  return out + html.slice(at);
}

/** The body with each medium whose uuid is in `hiddenKeys` swapped for a placeholder. */
export function withheldMediaPlaceholders(html: string, hiddenKeys: ReadonlySet<string>) {
  const keys = [...hiddenKeys].filter(Boolean).map((key) => key.toLowerCase());
  if (!keys.length) return html;
  return replaceSlices(
    html,
    mediaSlices(html)
      .map((slice, ref) => ({ ...slice, text: placeholder(ref) }))
      .filter((slice) => namesBodyMedia(slice.src, keys))
  );
}

/**
 * The saved body with each placeholder replaced by the stored medium it names. A placeholder that
 * names no stored medium in `hiddenKeys`, or names one twice, is refused.
 */
export function restoreWithheldMedia(
  html: string,
  storedHtml: string | null | undefined,
  hiddenKeys: ReadonlySet<string>
) {
  const placeholders = placeholderSlices(html);
  if (!placeholders.length) return html;
  const keys = [...hiddenKeys].filter(Boolean).map((key) => key.toLowerCase());
  const stored = storedHtml ? mediaSlices(storedHtml) : [];
  const used = new Set<number>();
  return replaceSlices(
    html,
    placeholders.map(({ start, end, ref }) => {
      const index = ref !== undefined && /^\d+$/.test(ref) ? Number(ref) : -1;
      const medium = stored[index];
      if (!medium || used.has(index) || !namesBodyMedia(medium.src, keys))
        throw throwBadRequestError('This article body names an image it does not hold');
      used.add(index);
      return { start, end, text: storedHtml!.slice(medium.start, medium.end) };
    })
  );
}

/**
 * The saved body, with each stored medium in `hiddenKeys` that it no longer names put back at the
 * end: a save from anywhere but the edit form cannot remove an image its saver may not see.
 */
export function keepWithheldMedia(
  html: string,
  storedHtml: string | null | undefined,
  hiddenKeys: ReadonlySet<string>
) {
  const keys = [...hiddenKeys].filter(Boolean).map((key) => key.toLowerCase());
  if (!storedHtml || !keys.length) return html;
  const saved = mediaSlices(html);
  const gone = keys.filter((key) => !saved.some((medium) => namesBodyMedia(medium.src, [key])));
  const missing = mediaSlices(storedHtml).filter((medium) => namesBodyMedia(medium.src, gone));
  return html + missing.map((medium) => storedHtml.slice(medium.start, medium.end)).join('');
}
