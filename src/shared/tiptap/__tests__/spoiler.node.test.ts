import { generateHTML } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import { articleContentJson } from '~/server/utils/article-content-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { removeSpoilers, sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { removeTags } from '~/utils/string-helpers';

const BODY =
  '<p>Act one. <span data-type="spoiler">The butler <strong>did</strong> it</span> end.</p>' +
  '<div data-type="spoiler"><p>Twist ending <img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/0b6f2c51-6b1e-4f0e-9a3c-1c2d3e4f5a6b/original=true" alt="final"></p></div>' +
  '<p>Credits.</p>';

// What `upsertArticleInput.content` applies on save.
const save = (html: string) => sanitizeHtml(html, { allowBlurbs: true });

type J = { type?: string; marks?: { type: string }[]; content?: J[] };
const findNode = (node: J, type: string): J | undefined =>
  node.type === type ? node : node.content?.map((c) => findNode(c, type)).find(Boolean);
const hasMark = (node: J, type: string): boolean =>
  !!node.marks?.some((m) => m.type === type) || !!node.content?.some((c) => hasMark(c, type));

describe('article spoilers', () => {
  it('survive the save sanitizer and parse back for the reader and the editor', () => {
    const stored = save(BODY);
    expect(stored).toContain('<span data-type="spoiler">');
    expect(stored).toContain('<div data-type="spoiler">');

    const json = articleContentJson(stored);
    expect(hasMark(json as J, 'spoiler')).toBe(true);
    expect(findNode(json as J, 'spoilerBlock')).toBeDefined();

    // The editor loads the stored HTML through the same parseHTML rules, and saves getHTML().
    const reserialised = generateHTML(json, tiptapExtensions);
    expect(reserialised).toContain(
      '<span data-type="spoiler">The butler <strong>did</strong> it</span>'
    );
    expect(reserialised).toMatch(/<div[^>]*data-type="spoiler"[^>]*><p>Twist ending/);
  });

  it('leave no spoiler text in a plain-text excerpt', () => {
    const excerpt = removeTags(removeSpoilers(save(BODY)));
    expect(excerpt).toBe('Act one. end. Credits.');
  });

  it('strip regardless of case or padding in the attribute', () => {
    expect(removeTags(removeSpoilers('<p>a <span data-type=" SPOILER ">x</span> b</p>'))).toBe(
      'a b'
    );
  });

  // A spoiler must not be a way past image scanning: media inside one is still collected.
  it('still expose an image inside a spoiler block to media extraction', () => {
    expect(getContentMedia(save(BODY)).map((m) => m.alt)).toEqual(['final']);
  });
});
