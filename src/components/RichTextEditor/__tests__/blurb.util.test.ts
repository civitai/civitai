import { generateHTML } from '@tiptap/html';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import {
  blurbPreview,
  insertBlurb,
  matchBlurbs,
  placesLabel,
  usageBreakdown,
  usesLabel,
} from '~/components/RichTextEditor/blurb.util';
import { BlurbNode } from '~/shared/tiptap/blurb.node';

function makeBlurb(overrides: Partial<BlurbItem> & Pick<BlurbItem, 'id' | 'name'>): BlurbItem {
  return {
    content: '',
    referenceCount: 0,
    referencesByEntityType: {},
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

describe('usesLabel', () => {
  it.each([
    [0, 'Not used yet'],
    [1, '1 use'],
    [2, '2 uses'],
    [41, '41 uses'],
  ])('renders %i as %s', (count, expected) => {
    expect(usesLabel(count)).toBe(expected);
  });
});

describe('placesLabel', () => {
  it.each([
    [1, '1 place'],
    [41, '41 places'],
  ])('renders %i as %s', (count, expected) => {
    expect(placesLabel(count)).toBe(expected);
  });
});

describe('usageBreakdown', () => {
  // Every entityType the plan ships an adapter for, in both numbers. `Bounty` is why this table
  // exists: the design's own sample says `1 bounty`, so the singular hides the broken plural.
  it.each([
    ['Article', '1 article', '2 articles'],
    ['Model', '1 model', '2 models'],
    ['ModelVersion', '1 model version', '2 model versions'],
    ['Bounty', '1 bounty', '2 bounties'],
    ['Challenge', '1 challenge', '2 challenges'],
    ['Changelog', '1 changelog entry', '2 changelog entries'],
    ['CosmeticShopItem', '1 shop item', '2 shop items'],
  ])('labels %s', (entityType, one, many) => {
    expect(usageBreakdown({ [entityType]: 1 })).toBe(one);
    expect(usageBreakdown({ [entityType]: 2 })).toBe(many);
  });

  it('renders the design sentence, largest first', () => {
    expect(usageBreakdown({ Bounty: 1, Model: 38, Article: 2 })).toBe(
      '38 models, 2 articles, 1 bounty'
    );
  });

  it('drops zero counts and an empty map', () => {
    expect(usageBreakdown({ Model: 3, Article: 0 })).toBe('3 models');
    expect(usageBreakdown({})).toBe('');
  });

  it('falls back to a derived plural for a type with no entry yet', () => {
    expect(usageBreakdown({ Gallery: 2 })).toBe('2 galleries');
    expect(usageBreakdown({ Gallery: 1 })).toBe('1 gallery');
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

  it('🔴 writes attrs the blurb node renders as a materialised span', () => {
    const { chain, calls } = makeChain();

    insertBlurb({ chain: () => chain } as never, {
      id: 7,
      content: 'Tip me: ko-fi.com/example',
    });

    const html = generateHTML(
      { type: 'doc', content: [{ type: 'paragraph', content: [calls.insertContent[0]] }] },
      [StarterKit.configure({ heading: false }), BlurbNode]
    );
    expect(html).toContain('<span data-type="blurb" data-id="7">Tip me: ko-fi.com/example</span>');
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
