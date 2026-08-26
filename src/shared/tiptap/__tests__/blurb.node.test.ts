import { generateHTML, generateJSON } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { BlurbNode } from '~/shared/tiptap/blurb.node';
import StarterKit from '@tiptap/starter-kit';

const extensions = [StarterKit.configure({ heading: false }), BlurbNode];

// `@tiptap/html`'s server serializer (zeed-dom) stamps `xmlns` on every TOP-LEVEL element — the
// `<p>` siblings here carry it too. A blurb is top-level now that it is a block, so the attribute
// shows up where it never did on the inline shape. It is not in any sanitize allowlist, so it
// never reaches a stored body.
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

  // The pre-block storage shape. Parsing it is what migrates an old body: opened and saved, it
  // comes back out as a div, so nothing has to rewrite the rows.
  it('still parses the legacy inline span, and re-renders it as a div', () => {
    const html = '<p><span data-type="blurb" data-id="7">hi</span></p>';
    const json = generateJSON(html, extensions);
    expect(JSON.stringify(json)).toContain('"type":"blurb"');
    expect(stripXmlns(generateHTML(json, extensions))).toContain(
      '<div data-type="blurb" data-id="7">hi</div>'
    );
  });

  it('holds a heading and a list, which the inline shape could not', () => {
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
