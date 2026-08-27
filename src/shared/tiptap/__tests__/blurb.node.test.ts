import { generateHTML, generateJSON } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { MAX_BLURB_ID } from '~/shared/constants/blurb.constants';
import { findBlurbSpans } from '~/server/utils/blurb-html';
import { BlurbNode } from '~/shared/tiptap/blurb.node';
import StarterKit from '@tiptap/starter-kit';

const extensions = [StarterKit.configure({ heading: false }), BlurbNode];

// `@tiptap/html`'s server serializer (zeed-dom) stamps `xmlns` on every TOP-LEVEL element, which
// a blurb is. It is not in any sanitize allowlist, so it never reaches a stored body.
const stripXmlns = (html: string) => html.replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '');

const render = (html: string) =>
  stripXmlns(generateHTML(generateJSON(html, extensions), extensions));

describe('BlurbNode', () => {
  it('parses a stored blurb back into a node', () => {
    const json = generateJSON('<div data-type="blurb" data-id="7">hi</div>', extensions);
    const node = (json as any).content[0];
    expect(node.type).toBe('blurb');
    expect(node.attrs.id).toBe(7);
    expect(node.attrs.text).toBe('hi');
  });

  it('renders back to the same stored shape', () => {
    const html = '<div data-type="blurb" data-id="7">hi</div>';
    expect(render(html)).toContain('<div data-type="blurb" data-id="7">hi</div>');
  });

  it('holds a heading and a list', () => {
    const html = '<div data-type="blurb" data-id="7"><h2>Terms</h2><ul><li>one</li></ul></div>';
    expect(render(html)).toContain(
      '<div data-type="blurb" data-id="7"><h2>Terms</h2><ul><li>one</li></ul></div>'
    );
  });

  it('leaves non-blurb spans alone', () => {
    const json = generateJSON('<p><span data-type="mention" data-id="7">@x</span></p>', extensions);
    const node = (json as any).content[0].content[0];
    expect(node.type).not.toBe('blurb');
  });
});

describe('BlurbNode markup round trip', () => {
  const html = '<div data-type="blurb" data-id="7">a <strong>b</strong> c</div>';

  it('parses the interior markup rather than its text', () => {
    const json = generateJSON(html, extensions);
    const node = (json as any).content[0];
    expect(node.attrs.text).toBe('a <strong>b</strong> c');
  });

  it('🔴 re-renders the markup rather than an escaped copy of it', () => {
    // Emitted as a string child, ProseMirror makes it a TEXT node and `<strong>` is escaped. The
    // next parse then reads `&lt;strong&gt;` as the text, so every open-and-save escapes again.
    expect(render(html)).toContain(
      '<div data-type="blurb" data-id="7">a <strong>b</strong> c</div>'
    );
  });

  it('🔴 does not re-escape a stored entity either', () => {
    const withEntity = '<div data-type="blurb" data-id="7">Tom &amp; Jerry</div>';
    expect(render(withEntity)).toContain(
      '<div data-type="blurb" data-id="7">Tom &amp; Jerry</div>'
    );
  });

  it('🔴 is stable across repeated open-and-save cycles', () => {
    let current = html;
    for (let i = 0; i < 3; i++) current = render(current);
    expect(current).toContain('<strong>b</strong>');
    expect(current).not.toContain('&lt;');
  });
});

// 🔴 Two parsers read the same `data-id` — this node's `parseHTML` and the server's
// `findBlurbSpans` — and they used to carry the bound by hand, at 9 digits and int4 max
// respectively. An id between them parsed to `id: null` here while the server still resolved it,
// and since `renderHTML` emits `data-id` only for a truthy id, the next save DROPPED the
// reference and the blurb quietly became plain text.
describe('BlurbNode — the id bound agrees with the server parser', () => {
  const parsedId = (id: string) => {
    const json = generateJSON(`<div data-type="blurb" data-id="${id}">x</div>`, extensions);
    const node = (json as any).content[0];
    return node.type === 'blurb' ? node.attrs.id : undefined;
  };
  const serverId = (id: string) =>
    findBlurbSpans(`<div data-type="blurb" data-id="${id}">x</div>`)[0]?.blurbId;

  it.each([
    ['1', 1],
    ['999999999', 999_999_999],
    // The 10-digit range that only one of the two used to accept.
    ['1000000000', 1_000_000_000],
    [String(MAX_BLURB_ID), MAX_BLURB_ID],
  ])('both accept %s', (raw, expected) => {
    expect(parsedId(raw)).toBe(expected);
    expect(serverId(raw)).toBe(expected);
  });

  it.each([
    ['past int4', String(MAX_BLURB_ID + 1)],
    ['not a number', 'abc'],
    ['negative', '-1'],
  ])('both reject %s', (_label, raw) => {
    expect(parsedId(raw)).toBeNull();
    expect(serverId(raw)).toBeUndefined();
  });
});
