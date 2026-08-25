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
