import { generateJSON } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { looksLikeMarkdown } from '~/utils/markdown-detect';
import { convertMarkdownForEditor, markdownToEditorHtml } from '~/utils/markdown-to-editor-html';

const tagsIn = (html: string) =>
  new Set(Array.from(html.matchAll(/<([a-z][a-z0-9-]*)/gi), (m) => m[1].toLowerCase()));

describe('looksLikeMarkdown', () => {
  // A fence or a table delimiter is near-unambiguous, so either alone is enough.
  it.each([
    ['fenced code', 'intro\n```\n1girl, solo\n```'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['heading plus a fence', '# Title\n\n```\n1girl\n```'],
  ])('detects %s', (_label, input) => {
    expect(looksLikeMarkdown(input)).toBe(true);
  });

  // `#` and `>` are ambiguous on their own (comments, quoted replies), so they
  // only count together.
  it('detects a heading and a blockquote together', () => {
    expect(looksLikeMarkdown('# Title\n\n> a note')).toBe(true);
  });

  it.each([
    ['plain prose', 'Just a sentence about a model I liked.'],
    ['emphasis only', 'This is **important** and `inline`.'],
    ['a bare url', 'https://example.com/some/path'],
  ])('ignores %s', (_label, input) => {
    expect(looksLikeMarkdown(input)).toBe(false);
  });

  // `# ` is a comment in Python/YAML/shell/TOML and `> ` is a quoted email line.
  // Converting on one of those alone invented headings and reflowed code — worse
  // than not converting, since the Import button covers whole documents.
  it.each([
    [
      'python with a comment',
      '# load the pipeline\nimport torch\nfrom diffusers import StableDiffusionPipeline\n\nmodel.__init__()',
    ],
    ['shell script', '#!/bin/bash\n# install deps\npnpm install --frozen-lockfile'],
    ['yaml config', '# generation defaults\nsteps: 30\ncfg: 7.5'],
    ['a quoted email reply', '> On Tue, someone wrote:\n> please review this'],
    ['an ini/toml section comment', '# [settings]\nwidth = 832\nheight = 1216'],
  ])('does not convert %s', (_label, input) => {
    expect(looksLikeMarkdown(input)).toBe(false);
  });
});

describe('convertMarkdownForEditor', () => {
  it('preserves the constructs the editor supports', () => {
    const html = markdownToEditorHtml(
      [
        '# H1',
        '## H2',
        '### H3',
        '',
        'Text with **bold**, *italic* and `inline code`.',
        '',
        '> a blockquote',
        '',
        '```',
        '1girl, solo, masterpiece',
        '```',
        '',
        '1. first',
        '2. second',
        '',
        '---',
      ].join('\n')
    );

    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code>1girl, solo, masterpiece');
    expect(html).toContain('<ol>');
    expect(html).toContain('<hr>');
  });

  it('down-converts a GFM table to an aligned code block', () => {
    const result = convertMarkdownForEditor(
      [
        '| Your generator | Use the | Notes |',
        '|---|---|---|',
        '| Illustrious | Tag block | negatives work |',
        '| Flux | Natural-language block | keep the tail |',
      ].join('\n')
    );

    expect(result.tablesConverted).toBe(1);
    expect(result.html).not.toContain('<table');
    expect(result.html).toContain('<pre><code>');
    expect(result.html).toContain('Natural-language block');

    // Every emitted row is padded to one width, so the block stays legible even
    // when the source table was ragged.
    const code = result.html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1] ?? '';
    const rows = code.trim().split('\n');

    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    expect(rows[1]).toMatch(/^\|( -+ \|)+$/);
  });

  it('keeps blockquotes intact', () => {
    const html = markdownToEditorHtml('> Diamond-pattern chaos.\n> Best on manic OCs.');

    expect(html).toContain('<blockquote>');
    expect(html).toContain('Diamond-pattern chaos.');
    expect(sanitizeHtml(html)).toContain('<blockquote>');
  });

  // Image extraction only accepts Civitai-hosted URLs, so an off-site <img> is
  // never scanned nor counted by the publish gate, and leaks reader IPs to the
  // host. Import must not create one.
  it('demotes an off-site image to a link', () => {
    const result = convertMarkdownForEditor('![a shot](https://evil.example/tracker.jpg)');

    expect(result.externalImagesLinked).toBe(1);
    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('href="https://evil.example/tracker.jpg"');
    expect(result.html).toContain('a shot');
    expect(sanitizeHtml(result.html)).not.toContain('<img');
  });

  it('falls back to the url as link text when there is no alt', () => {
    const result = convertMarkdownForEditor('![](https://evil.example/x.png)');

    expect(result.externalImagesLinked).toBe(1);
    expect(result.html).toContain('https://evil.example/x.png');
  });

  it('keeps a Civitai-hosted image, which scanning can see', () => {
    const url = 'https://image.civitai.com/abc/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/original';
    const result = convertMarkdownForEditor(`![ok](${url})`);

    expect(result.externalImagesLinked).toBe(0);
    expect(result.html).toContain('<img');
    expect(result.html).toContain(url);
  });

  it('clamps headings deeper than h3', () => {
    const result = convertMarkdownForEditor('#### Deep\n\n##### Deeper');

    expect(result.headingsClamped).toBe(2);
    expect(result.html).toContain('<h3>Deep</h3>');
    expect(result.html).toContain('<h3>Deeper</h3>');
    expect(result.html).not.toMatch(/<h[456]/);
  });

  it('flattens task list items, which would lose their checkbox to the sanitizer', () => {
    const result = convertMarkdownForEditor('- [x] done\n- [ ] todo');

    expect(result.taskItemsConverted).toBe(2);
    expect(result.html).not.toContain('<input');
    expect(result.html).toContain('[x] done');
    expect(result.html).toContain('[ ] todo');
  });

  it('emits <s> rather than <del> for strikethrough', () => {
    const html = markdownToEditorHtml('~~gone~~');

    expect(html).toContain('<s>gone</s>');
    expect(html).not.toContain('<del>');
  });

  it('strips yaml frontmatter', () => {
    const html = markdownToEditorHtml('---\ntitle: Draft\n---\n\n# Real title');

    expect(html).toContain('<h1>Real title</h1>');
    expect(html).not.toContain('title: Draft');
  });

  // A leading `---` is far more often a horizontal rule than a frontmatter
  // fence; eating up to the next `---` would silently drop the first section.
  it('leaves a leading horizontal rule alone', () => {
    const html = markdownToEditorHtml('---\n\n# Real title\n\nBody text.\n\n---');

    expect(html).toContain('<h1>Real title</h1>');
    expect(html).toContain('Body text.');
  });

  it('escapes embedded raw html rather than executing it', () => {
    const html = markdownToEditorHtml('<script>alert(1)</script>\n\n# Safe');

    expect(html).not.toContain('<script');
    expect(html).toContain('<h1>Safe</h1>');
  });

  // Prompts are the most common thing in an article here, and both of these were
  // silently losing characters: remark deletes html nodes wholesale, and an
  // autolink with a non-web scheme gets demoted to a bare span by the sanitizer.
  it('keeps angle-bracket placeholders in prose', () => {
    const html = markdownToEditorHtml('replace <your-token> with your key');

    expect(sanitizeHtml(html)).toContain('&lt;your-token&gt;');
  });

  it('keeps a lora tag usable instead of demoting it to a span', () => {
    const html = markdownToEditorHtml('use <lora:add_detail:0.8> in the prompt');

    expect(sanitizeHtml(html)).toContain('&lt;lora:add_detail:0.8&gt;');
    expect(sanitizeHtml(html)).not.toContain('<span>');
  });

  it('still linkifies a real autolink', () => {
    const html = markdownToEditorHtml('see <https://example.com/docs>');

    expect(html).toContain('href="https://example.com/docs"');
  });

  // The reason this module exists: the sanitizer runs as a zod preprocess on
  // save, so anything it drops is lost after the author already hit publish.
  // `getArticleById` derives `contentJson` from the stored HTML with
  // `generateJSON(content, tiptapExtensions)` and the public REST endpoint
  // (`/api/v1/articles/[id]`) returns it verbatim. So the imported HTML has to
  // survive sanitize AND still parse into the tiptap schema — otherwise nodes
  // vanish between save and read.
  it('round-trips imported content through sanitize into the tiptap schema', () => {
    const { html } = convertMarkdownForEditor(
      [
        '## Look 1',
        '',
        '> Diamond-pattern chaos.',
        '',
        '| Generator | Dialect |',
        '|---|---|',
        '| Flux | NL |',
        '',
        '```',
        '1girl, solo',
        '```',
      ].join('\n')
    );

    const stored = sanitizeHtml(html);
    expect(stored).toContain('<blockquote>');

    const contentJson = generateJSON(stored, tiptapExtensions);
    const types = new Set<string>();
    const walk = (node: { type?: string; content?: unknown[] }) => {
      if (node.type) types.add(node.type);
      ((node.content ?? []) as (typeof node)[]).forEach(walk);
    };
    walk(contentJson);

    expect(types).toContain('blockquote');
    expect(types).toContain('codeBlock');
    expect(types).toContain('heading');
    // Node types must be JSON-serializable for the REST payload.
    expect(() => JSON.stringify(contentJson)).not.toThrow();
  });

  it('produces only tags that survive the server-side sanitizer', () => {
    const html = markdownToEditorHtml(
      [
        '# Title',
        '#### Too deep',
        '',
        'Body with **bold**, *italic*, `code` and ~~strike~~.',
        '',
        '> quote',
        '',
        '```',
        'fenced',
        '```',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- [x] task',
        '- bullet',
        '',
        '1. ordered',
        '',
        '---',
      ].join('\n')
    );

    expect(tagsIn(sanitizeHtml(html))).toEqual(tagsIn(html));
  });
});
