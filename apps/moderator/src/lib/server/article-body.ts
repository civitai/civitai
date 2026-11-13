import { HTML_MAX_CHARS, convertHtml, decodeEntities } from './html-to-text';

/**
 * An article body as the article queue shows it: the text, with each image and embed back where the
 * author put it. Still TEXT — the body is author-written markup rendered in a moderator's session, so
 * nothing of it is ever `{@html}` — but split at the media, so "the third image" in a report is the
 * third one down the column rather than one in a grid under the whole body.
 *
 * The editor writes an image as `<edge-media url="<Image.url>" type="image">`, and each one is a
 * connected image (151 of 151 across 30 recent articles, 2026-10-16), so the page renders it as that
 * Image. A pasted `<img src>` is usually another site's URL; it is carried as a link, not loaded,
 * until the moderator asks (`ArticlePreview`).
 */
export type ArticleSegment =
  | { kind: 'text'; text: string }
  /** An `Image.url` — the page finds the Image in the article's images to show its flags. */
  | { kind: 'media'; url: string; mediaType: 'image' | 'video' }
  | { kind: 'external'; src: string; alt: string | null }
  | { kind: 'embed'; src: string };

export type ArticleBody = { segments: ArticleSegment[]; truncated: boolean };

/** Characters of text kept. The site has the rest. */
export const ARTICLE_TEXT_LIMIT = 20_000;

/**
 * A media tag. Attribute values may hold `>`, but nothing crosses a `<` — the bound that keeps a failed
 * match from scanning the rest of the input (the rule `html-to-text.ts` explains), so the split is
 * linear in the body.
 */
const MEDIA_RE = /<(edge-media|img|iframe)\b((?:"[^"<]*"|'[^'<]*'|[^'"<>])*)>/gi;

// Preceded by whitespace, not a word boundary: `\b` matches inside `data-url`, and a `data-src` would
// be read as the image.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  );
  const raw = m ? m[1] ?? m[2] ?? m[3] ?? '' : null;
  return raw == null ? null : decodeEntities(raw).trim() || null;
}

/** Only a web address is linked or loaded — never `javascript:`, `data:` or a relative path. */
const webUrl = (v: string | null) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

function mediaSegment(tag: string, attrs: string): ArticleSegment | null {
  switch (tag.toLowerCase()) {
    case 'edge-media': {
      const url = attr(attrs, 'url');
      if (!url) return null;
      // The editor writes an `Image.url` (a key, not an address), but the site's sanitiser does not
      // check the value: one naming an address would be fetched by `EdgeMedia` the moment the panel
      // opened. So an address is an outside image, behind a click. (The panel also renders a key only
      // when it is one of the article's own images.)
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
        const src = webUrl(url.startsWith('//') ? `https:${url}` : url);
        return src ? { kind: 'external', src, alt: attr(attrs, 'filename') } : null;
      }
      return { kind: 'media', url, mediaType: attr(attrs, 'type') === 'video' ? 'video' : 'image' };
    }
    case 'img': {
      const src = webUrl(attr(attrs, 'src'));
      return src ? { kind: 'external', src, alt: attr(attrs, 'alt') } : null;
    }
    default: {
      const src = webUrl(attr(attrs, 'src'));
      return src ? { kind: 'embed', src } : null;
    }
  }
}

export function articleBody(html: string | null | undefined): ArticleBody | null {
  if (!html) return null;
  const input = html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  const segments: ArticleSegment[] = [];
  let budget = ARTICLE_TEXT_LIMIT;
  let truncated = input.length < html.length;

  // Each run of HTML between two media tags is converted on its own. A run can open an element the
  // next one closes (a `<p>` around an image); the converter takes unbalanced markup as it comes.
  const pushText = (chunk: string) => {
    if (!chunk || budget <= 0) return;
    const { text, complete } = convertHtml(chunk);
    const trimmed = text.trim();
    if (!complete) truncated = true;
    if (!trimmed) return;
    if (trimmed.length > budget) truncated = true;
    segments.push({ kind: 'text', text: trimmed.slice(0, budget) });
    budget -= trimmed.length;
  };

  let at = 0;
  for (const m of input.matchAll(MEDIA_RE)) {
    pushText(input.slice(at, m.index));
    at = m.index + m[0].length;
    // Past the text cut nothing more is shown inline; the article's images are still in the grid.
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const segment = mediaSegment(m[1], m[2]);
    if (segment) segments.push(segment);
  }
  if (budget > 0) pushText(input.slice(at));

  return segments.length ? { segments, truncated } : null;
}
