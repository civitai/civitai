import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import {
  rehypeTosSectionIds,
  TOS_PROHIBITED_CONTENT_ID,
} from '~/components/Markdown/rehype-tos-section-ids';

/**
 * The plugin is the FALLBACK for the prohibited-content anchor — the ToS files carry the id
 * themselves, and `server/services/__tests__/tos-prohibited-content-anchor.test.ts` guards that. What
 * matters here is the recovery path: a document that lost the anchor still gets one, and a document
 * that has one is left alone.
 */
const CONTENT_ROOT = join(process.cwd(), 'src', 'static-content');

// `[\w-]`, not `[a-z]`: a `tos.pt-BR.md` would otherwise be invisible to this suite entirely.
const tosFiles = readdirSync(CONTENT_ROOT).filter((f) => /^tos(\.[\w-]+)?\.md$/.test(f));

const render = (markdown: string) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeTosSectionIds)
    .runSync(unified().use(remarkParse).use(remarkGfm).parse(markdown));

const findId = (node: any, id: string): any => {
  if (node?.properties?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findId(child, id);
    if (hit) return hit;
  }
  return null;
};

const countId = (node: any, id: string): number =>
  (node?.properties?.id === id ? 1 : 0) +
  (node?.children ?? []).reduce((n: number, c: any) => n + countId(c, id), 0);

const textOf = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
};

/**
 * The REAL ToS with its anchor stripped — i.e. a file that lost it.
 *
 * Not a synthetic snippet: one that starts at 9.6 makes the top-level list itself match the pattern,
 * so the plugin tags the `<ul>` and its descent into children is never exercised — and that descent is
 * the only path that works on a document whose list starts at "1.".
 */
const withoutAnchor = (file = 'tos.md') =>
  readFileSync(join(CONTENT_ROOT, file), 'utf8').replace(
    new RegExp(`<a id="${TOS_PROHIBITED_CONTENT_ID}"></a>`, 'g'),
    ''
  );

describe('rehypeTosSectionIds', () => {
  // Guards the discovery: without it the per-file assertions below pass vacuously over an empty list.
  it('finds the ToS variants to check', () => {
    expect(tosFiles.length).toBeGreaterThanOrEqual(2);
    expect(tosFiles).toContain('tos.md');
  });

  it.each(tosFiles)('leaves %s alone — it carries its own anchor', (file) => {
    const tree = render(readFileSync(join(CONTENT_ROOT, file), 'utf8'));

    // Exactly one, and it is the empty `<a>` from the ToS body rather than a section the plugin tagged.
    expect(countId(tree, TOS_PROHIBITED_CONTENT_ID)).toBe(1);
    expect(findId(tree, TOS_PROHIBITED_CONTENT_ID).tagName).toBe('a');
  });

  it.each(tosFiles)('re-derives the anchor for %s if it loses one', (file) => {
    const tree = render(withoutAnchor(file));

    const anchored = findId(tree, TOS_PROHIBITED_CONTENT_ID);
    expect(anchored, 'a ToS without the anchor should still be reachable').not.toBeNull();
    // The list ITEM that opens 9.6, not an ancestor of it. `textOf` is inherited upward, so
    // `toContain` alone passes for every wrapper up to <body> — and would still pass with the
    // plugin's descent into children deleted.
    expect(anchored.tagName).toBe('li');
    expect(textOf(anchored).trimStart().startsWith('9.6')).toBe(true);
  });

  it('falls back to the intro sentence when the numbering changes', () => {
    const tree = render(
      withoutAnchor().replace('- 9.6 **Content Moderation.**', '- 9.7 **Content Moderation.**')
    );

    const anchored = findId(tree, TOS_PROHIBITED_CONTENT_ID);
    expect(anchored).not.toBeNull();
    // The intro paragraph itself — the <li> above no longer matches, and its ancestors are over the
    // length guard, so anything but <p> means the fallback caught the wrong element.
    expect(anchored.tagName).toBe('p');
    expect(textOf(anchored)).toContain('expressly prohibited');
  });

  it('leaves a document without the section untouched rather than guessing', () => {
    // Fail-soft is the contract: no anchor means the modal opens at the top, and the reader can still
    // accept. Guessing at an unrelated element would scroll them somewhere misleading instead.
    const tree = render('# Something else\n\nNo prohibited content section here.\n');

    expect(findId(tree, TOS_PROHIBITED_CONTENT_ID)).toBeNull();
  });
});
