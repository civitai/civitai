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

  // A code block is width-constrained in the editor, so a padded pipe table
  // wrapped mid-row and was unreadable. A list reflows.
  it('down-converts a GFM table to a nested list', () => {
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
    expect(result.html).not.toContain('<pre>');
    expect(result.html).toContain('<ul>');

    // One top-level item per body row, and every cell keeps its column name so
    // nothing about the table's meaning is lost.
    expect(result.html).toContain('<strong>Your generator: </strong>');
    expect(result.html).toContain('Illustrious');
    expect(result.html).toContain('Flux');
    expect(result.html).toContain('<strong>Use the: </strong>');
    expect(result.html).toContain('Natural-language block');
    expect(result.html).toContain('<strong>Notes: </strong>');
    expect(result.html).toContain('keep the tail');
  });

  // Flattening cells to text used to discard hrefs, and download tables are the
  // most common table in a Civitai article.
  it('keeps link targets from table cells', () => {
    const result = convertMarkdownForEditor(
      '| Model | File |\n|---|---|\n| Flux | [dl](https://example.com/a.zip) |'
    );

    expect(result.html).toContain('href="https://example.com/a.zip"');
  });

  it('lists the column names for a header-only table', () => {
    const result = convertMarkdownForEditor('| a | b |\n|---|---|');

    expect(result.tablesConverted).toBe(1);
    expect(result.html).toContain('<ul>');
    expect(result.html).toContain('a');
    expect(result.html).toContain('b');
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

  it('leaves an hr followed by prose containing a colon alone', () => {
    const html = markdownToEditorHtml('---\n\nNote: this is prose\n\n---');

    expect(html).toContain('Note: this is prose');
  });

  // Blank lines are ordinary in frontmatter. Rejecting the fence over one left
  // the closing `---` acting as a setext underline, promoting the last key to a
  // heading inside the author's article.
  it('strips frontmatter that contains a blank line', () => {
    const html = markdownToEditorHtml('---\ntitle: A\n\nauthor: B\n---\n\n# Body');

    expect(html).toBe('<h1>Body</h1>');
  });

  it.each([
    ['a BOM', '﻿---\ntitle: A\n---\n\n# Body'],
    ['CRLF newlines', '---\r\ntitle: A\r\n---\r\n\r\n# Body'],
  ])('strips frontmatter with %s', (_label, input) => {
    expect(markdownToEditorHtml(input)).toBe('<h1>Body</h1>');
  });

  // remark keeps body cells past the header width, so they must survive even
  // though they have no header to be labelled with.
  it('keeps every cell of a ragged table', () => {
    const result = convertMarkdownForEditor('| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |');

    for (const cell of ['1', '2', '3', '4']) expect(result.html).toContain(cell);
  });

  it.each([
    ['a yaml comment', '---\ntitle: A\n# TODO: update\ndate: 2024-01-01\n---\n\n# Body'],
    ['a url value', '---\nhome: https://example.com\n---\n\n# Body'],
    ['an indented block scalar', '---\ntitle: A\nnote: |\n    ---\n    secret\n---\n\n# Body'],
  ])('strips frontmatter containing %s', (_label, input) => {
    expect(markdownToEditorHtml(input)).toBe('<h1>Body</h1>');
  });

  // A `---` rule followed by prose is not frontmatter, even when a line happens
  // to match `key:` — deleting it silently ate real article content.
  it.each([
    ['a Version: line', '---\nVersion: 1.2.0\n\nFixed things.\n\n---\n\nMore stuff'],
    ['a bare url', '---\nhttps://example.com\n\n---\n\nBody'],
  ])('does not eat body content after an hr with %s', (_label, input) => {
    const html = markdownToEditorHtml(input);

    expect(html).toContain('<hr>');
    expect(html).not.toBe('<h1>Body</h1>');
  });

  it('drops html comments rather than publishing them as text', () => {
    expect(markdownToEditorHtml('<!-- private note -->\n\n# Body')).toBe('<h1>Body</h1>');
  });

  it('drops real html wrappers rather than publishing the markup', () => {
    const html = markdownToEditorHtml(
      '<div align="center">\n  <img src="https://evil.example/x.png" />\n</div>\n\n# Body'
    );

    expect(html).toBe('<h1>Body</h1>');
  });

  // `br` is allowlisted and in the tiptap schema, so it should stay a break
  // rather than become the literal text `<br>`.
  it('keeps <br> as a line break', () => {
    expect(markdownToEditorHtml('line one<br>line two')).toContain('<br>');
  });

  // Reference style reaches the same `<img>`, so it must be demoted too or the
  // whole point of the off-site rule is bypassed.
  it('demotes a reference-style off-site image', () => {
    const result = convertMarkdownForEditor('![cat][c]\n\n[c]: https://evil.example/cat.png');

    expect(result.externalImagesLinked).toBe(1);
    expect(result.html).not.toContain('<img');
  });

  it('resolves a reference-style Civitai image to a real src', () => {
    const url = 'https://image.civitai.com/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/original';
    const result = convertMarkdownForEditor(`![ok][c]\n\n[c]: ${url}`);

    expect(result.externalImagesLinked).toBe(0);
    expect(result.html).toContain(`src="${url}"`);
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
