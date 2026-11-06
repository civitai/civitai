/**
 * What a crawler reads from a page, extracted from its HTML, for the lean-render parity test
 * (`bot-lean-images-parity.test.ts`): the head's SEO tags, the JSON-LD (parsed), the body's
 * visible text, its `<img>`s and its links. Two renders that extract equal are the same page to a
 * crawler that does not run scripts.
 *
 * Parsed with htmlparser2 (entities decoded), not with regexes: the full render and the lean page
 * serialise the same content differently (attribute order, quoting, `&amp;` vs `&#x27;`, React's
 * `<!-- -->` text separators), and only a parser reads both the same way.
 */
import { Parser } from 'htmlparser2';

export type SeoImage = {
  src: string | null;
  alt: string | null;
  width: string | null;
  height: string | null;
  srcset: string | null;
};

export type SeoExtract = {
  title: string[];
  /** `[name-or-property, content]`, in document order, for every SEO-relevant `<meta>`. */
  meta: [string, string][];
  canonical: string[];
  alternate: string[];
  jsonLd: unknown[];
  /**
   * The body's text in document order, one entry per run of text between two tags (React's
   * `<!-- -->` separators do not split a run), whitespace collapsed, empty runs dropped.
   */
  text: string[];
  images: SeoImage[];
  /** Every `<a href>`, sorted, duplicates kept once. */
  links: string[];
  /** Whether the page carries the React data blob (the lean page must not). */
  hasNextData: boolean;
};

const SEO_META_NAMES = new Set(['title', 'description', 'robots', 'keywords', 'googlebot']);
const isSeoProperty = (p: string) => p.startsWith('og:') || p.startsWith('twitter:');
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'title', 'head']);

export function normaliseText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractSeo(html: string): SeoExtract {
  const out: SeoExtract = {
    title: [],
    meta: [],
    canonical: [],
    alternate: [],
    jsonLd: [],
    text: [],
    images: [],
    links: [],
    hasNextData: false,
  };
  let run = '';
  const flush = () => {
    const value = normaliseText(run);
    if (value) out.text.push(value);
    run = '';
  };
  const links = new Set<string>();
  const stack: string[] = [];
  let titleBuf: string | null = null;
  let jsonLdBuf: string | null = null;

  const inside = (names: Set<string>) => stack.some((name) => names.has(name));

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        flush();
        stack.push(name);
        if (name === 'title' && stack.includes('head')) titleBuf = '';
        if (name === 'meta') {
          const key = attrs.name ?? attrs.property;
          if (key && attrs.content !== undefined) {
            if (SEO_META_NAMES.has(key.toLowerCase()) || isSeoProperty(key))
              out.meta.push([key, attrs.content]);
          }
        }
        if (name === 'link' && attrs.rel === 'canonical') out.canonical.push(attrs.href ?? '');
        if (name === 'link' && attrs.rel === 'alternate') out.alternate.push(attrs.href ?? '');
        if (name === 'script' && attrs.type === 'application/ld+json') jsonLdBuf = '';
        if (name === 'script' && attrs.id === '__NEXT_DATA__') out.hasNextData = true;
        if (name === 'img' && !stack.includes('head')) {
          out.images.push({
            src: attrs.src ?? null,
            alt: attrs.alt ?? null,
            width: attrs.width ?? null,
            height: attrs.height ?? null,
            srcset: attrs.srcset ?? null,
          });
        }
        if (name === 'a' && attrs.href !== undefined) links.add(attrs.href);
      },
      ontext(data) {
        if (titleBuf !== null) titleBuf += data;
        if (jsonLdBuf !== null) jsonLdBuf += data;
        if (!inside(SKIP_TEXT)) run += data;
      },
      onclosetag(name) {
        flush();
        if (name === 'title' && titleBuf !== null) {
          out.title.push(normaliseText(titleBuf));
          titleBuf = null;
        }
        if (name === 'script' && jsonLdBuf !== null) {
          out.jsonLd.push(JSON.parse(jsonLdBuf));
          jsonLdBuf = null;
        }
        // Void and unclosed elements: pop back to the matching open tag.
        const at = stack.lastIndexOf(name);
        if (at !== -1) stack.length = at;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();

  flush();
  out.links = [...links].sort();
  return out;
}

/** The fields the parity test compares: everything but the React-data marker. */
export function seoOf(html: string) {
  const { hasNextData: _, ...seo } = extractSeo(html);
  return seo;
}
