import { generateHTML } from '@tiptap/html';
import type { JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { blurbPreview, insertBlurb, matchBlurbs } from '~/components/RichTextEditor/blurb.util';
import { BlurbNode } from '~/shared/tiptap/blurb.node';

function makeBlurb(overrides: Partial<BlurbItem> & Pick<BlurbItem, 'id' | 'name'>): BlurbItem {
  return {
    content: '',
    ...overrides,
  };
}

describe('blurbPreview', () => {
  it('strips tags and decodes entities', () => {
    expect(blurbPreview('<p>Tip me <strong>&amp;</strong> thanks &mdash; really</p>')).toBe(
      'Tip me & thanks — really'
    );
  });

  it('returns an empty string for empty content', () => {
    expect(blurbPreview('')).toBe('');
  });
});

describe('matchBlurbs', () => {
  const blurbs = [
    makeBlurb({ id: 1, name: 'support-footer', content: '<p>Tip me: ko-fi.com/example</p>' }),
    makeBlurb({ id: 2, name: 'license-terms', content: '<p>Commercial use allowed.</p>' }),
    makeBlurb({ id: 3, name: 'flux-settings', content: '<p>Steps 28 &middot; CFG 3.5</p>' }),
  ];

  it('returns everything for an empty query', () => {
    expect(matchBlurbs(blurbs, '').map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it('matches on name, case-insensitively', () => {
    expect(matchBlurbs(blurbs, 'SUP').map((x) => x.id)).toEqual([1]);
  });

  it('matches on the decoded preview text', () => {
    expect(matchBlurbs(blurbs, 'commercial').map((x) => x.id)).toEqual([2]);
  });

  it('caps the result at the limit', () => {
    expect(matchBlurbs(blurbs, '', 2)).toHaveLength(2);
  });
});

describe('insertBlurb', () => {
  function makeChain() {
    const calls: { deleteRange: unknown[]; insertContent: unknown[] } = {
      deleteRange: [],
      insertContent: [],
    };
    const chain = {
      focus: () => chain,
      deleteRange: (range: unknown) => {
        calls.deleteRange.push(range);
        return chain;
      },
      insertContent: (content: unknown) => {
        calls.insertContent.push(content);
        return chain;
      },
      run: () => true,
    };
    return { chain, calls };
  }

  it('🔴 writes attrs the blurb node renders as a materialised div', () => {
    const { chain, calls } = makeChain();

    insertBlurb({ chain: () => chain } as never, {
      id: 7,
      content: 'Tip me: ko-fi.com/example',
    });

    const html = generateHTML({ type: 'doc', content: [calls.insertContent[0] as JSONContent] }, [
      StarterKit.configure({ heading: false }),
      BlurbNode,
    ]);
    // zeed-dom stamps `xmlns` on every top-level element in the server serializer; it is in no
    // sanitize allowlist, so it never reaches a stored body.
    expect(html.replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '')).toContain(
      '<div data-type="blurb" data-id="7">Tip me: ko-fi.com/example</div>'
    );
  });

  it('deletes the replaced range only when one is given', () => {
    const withRange = makeChain();
    insertBlurb(
      { chain: () => withRange.chain } as never,
      { id: 7, content: 'x' },
      {
        from: 4,
        to: 8,
      }
    );
    expect(withRange.calls.deleteRange).toEqual([{ from: 4, to: 8 }]);

    const without = makeChain();
    insertBlurb({ chain: () => without.chain } as never, { id: 7, content: 'x' });
    expect(without.calls.deleteRange).toEqual([]);
  });
});
