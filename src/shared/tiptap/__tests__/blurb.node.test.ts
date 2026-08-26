import { generateHTML, generateJSON } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { BlurbNode } from '~/shared/tiptap/blurb.node';
import StarterKit from '@tiptap/starter-kit';

const extensions = [StarterKit.configure({ heading: false }), BlurbNode];

describe('BlurbNode', () => {
  it('parses a stored blurb span back into a node', () => {
    const json = generateJSON('<p><span data-type="blurb" data-id="7">hi</span></p>', extensions);
    const node = (json as any).content[0].content[0];
    expect(node.type).toBe('blurb');
    expect(node.attrs.id).toBe(7);
    expect(node.attrs.text).toBe('hi');
  });

  it('renders back to the same stored shape', () => {
    const html = '<p><span data-type="blurb" data-id="7">hi</span></p>';
    expect(generateHTML(generateJSON(html, extensions), extensions)).toContain(
      '<span data-type="blurb" data-id="7">hi</span>'
    );
  });

  it('leaves non-blurb spans alone', () => {
    const json = generateJSON('<p><span data-type="mention" data-id="7">@x</span></p>', extensions);
    const node = (json as any).content[0].content[0];
    expect(node.type).not.toBe('blurb');
  });
});

describe('BlurbNode markup round trip', () => {
  const html = '<p><span data-type="blurb" data-id="7">a <strong>b</strong> c</span></p>';

  it('parses the interior markup rather than its text', () => {
    const json = generateJSON(html, extensions);
    const node = (json as any).content[0].content[0];
    expect(node.attrs.text).toBe('a <strong>b</strong> c');
  });

  it('🔴 re-renders the markup rather than an escaped copy of it', () => {
    // Emitted as a string child, ProseMirror makes it a TEXT node and `<strong>` is escaped. The
    // next parse then reads `&lt;strong&gt;` as the text, so every open-and-save escapes again.
    expect(generateHTML(generateJSON(html, extensions), extensions)).toContain(
      '<span data-type="blurb" data-id="7">a <strong>b</strong> c</span>'
    );
  });

  it('🔴 does not re-escape a stored entity either', () => {
    const withEntity = '<p><span data-type="blurb" data-id="7">Tom &amp; Jerry</span></p>';
    expect(generateHTML(generateJSON(withEntity, extensions), extensions)).toContain(
      '<span data-type="blurb" data-id="7">Tom &amp; Jerry</span>'
    );
  });

  it('🔴 is stable across repeated open-and-save cycles', () => {
    let current = html;
    for (let i = 0; i < 3; i++)
      current = generateHTML(generateJSON(current, extensions), extensions);
    expect(current).toContain('<strong>b</strong>');
    expect(current).not.toContain('&lt;');
  });
});
