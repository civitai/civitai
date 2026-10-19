import type { TurnSource } from './types';

// The assistant's answer as the moderator reads it. Client-safe and dependency-free: the answer is
// model output that can quote user-authored text, so it is escaped first and only a small, fixed
// subset of markdown is turned back into markup.

/** A citation: `[user:123]`. The kinds are the records tools return; anything else is plain text. */
export const CITATION = /\[(user|report|image|model|post|run):(\d{1,10})\]/g;

export function citationsIn(answer: string): string[] {
  return [...new Set([...answer.matchAll(CITATION)].map((m) => `${m[1]}:${m[2]}`))];
}

/** Citations no tool returned in this chat. Shown as unverified rather than as links. */
export function unverifiedCitations(answer: string, known: Iterable<string>): string[] {
  const set = new Set(known);
  return citationsIn(answer).filter((ref) => !set.has(ref));
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Only app-relative paths become links. A source's `href` is built server-side, but this is the last
 *  place an attacker-shaped value could reach an attribute, so it is checked here too. */
const safeHref = (href: string) => /^\/[a-z0-9/_?=&%.,:-]*$/i.test(href) && !href.startsWith('//');

function inline(text: string, sources: Map<string, TurnSource>): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(CITATION, (whole, kind: string, id: string) => {
      const ref = `${kind}:${id}`;
      const source = sources.get(ref);
      if (source && safeHref(source.href))
        return `<a class="cite" href="${escapeHtml(
          source.href
        )}" target="_blank" rel="noopener">${ref}</a>`;
      return `<span class="cite-unverified" title="No tool returned this record in this chat">${ref}?</span>`;
    });
}

/**
 * Paragraphs, `#` headings, `-`/`*` and `1.` lists, fenced code blocks, `**bold**`, `` `code` `` and
 * citations. Tables and links written by the model stay as text: the only links on the page are the
 * ones tools vouched for. A fenced block is copied verbatim (the assistant puts id lists there for
 * pasting into Bulk Ban), so nothing inside one becomes a link.
 */
export function renderAnswer(answer: string, sources: TurnSource[]): string {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const out: string[] = [];
  const open: {
    list: { tag: 'ul' | 'ol'; items: string[] } | null;
    paragraph: string[];
    fence: string[] | null;
  } = { list: null, paragraph: [], fence: null };

  const flushParagraph = () => {
    if (open.paragraph.length)
      out.push(`<p>${open.paragraph.map((l) => inline(l, byRef)).join('<br>')}</p>`);
    open.paragraph = [];
  };
  const flushList = () => {
    const list = open.list;
    if (list)
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    open.list = null;
  };
  const flushFence = () => {
    if (open.fence) out.push(`<pre><code>${escapeHtml(open.fence.join('\n'))}</code></pre>`);
    open.fence = null;
  };

  for (const raw of answer.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      if (open.fence) flushFence();
      else {
        flushParagraph();
        flushList();
        open.fence = [];
      }
      continue;
    }
    if (open.fence) {
      open.fence.push(line);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h4>${inline(heading[1], byRef)}</h4>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (open.list?.tag !== tag) {
        flushList();
        open.list = { tag, items: [] };
      }
      open.list.items.push(inline((bullet ?? numbered)![1], byRef));
    } else {
      flushList();
      open.paragraph.push(line);
    }
  }
  flushFence();
  flushParagraph();
  flushList();
  return out.join('');
}
