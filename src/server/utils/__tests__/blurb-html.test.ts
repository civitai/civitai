import { describe, expect, it } from 'vitest';
import {
  findBlurbSpans,
  renderBlurbSpan,
  replaceBlurbSpans,
  unwrapBlurbSpans,
} from '~/server/utils/blurb-html';

describe('findBlurbSpans', () => {
  it('finds a simple span', () => {
    const html = '<p>a</p><span data-type="blurb" data-id="7">hi</span>';
    const spans = findBlurbSpans(html);
    expect(spans).toHaveLength(1);
    expect(spans[0].blurbId).toBe(7);
    expect(html.slice(spans[0].innerStart, spans[0].innerEnd)).toBe('hi');
  });

  it('finds spans whose content contains nested markup', () => {
    const html = '<span data-type="blurb" data-id="3"><strong>bo</strong><span>ld</span></span>';
    const spans = findBlurbSpans(html);
    expect(spans).toHaveLength(1);
    expect(html.slice(spans[0].innerStart, spans[0].innerEnd)).toBe(
      '<strong>bo</strong><span>ld</span>'
    );
  });

  it('ignores spans that are not blurbs', () => {
    const html = '<span data-type="mention" data-id="7">@x</span><span data-id="7">y</span>';
    expect(findBlurbSpans(html)).toHaveLength(0);
  });

  it('ignores a blurb span with a non-numeric id', () => {
    expect(findBlurbSpans('<span data-type="blurb" data-id="abc">x</span>')).toHaveLength(0);
  });

  it('finds multiple spans in document order', () => {
    const html =
      '<span data-type="blurb" data-id="1">a</span>mid<span data-type="blurb" data-id="2">b</span>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([1, 2]);
  });

  it('orders a nested pair outer-first', () => {
    const html =
      '<span data-type="blurb" data-id="1">outer<span data-type="blurb" data-id="2">inner</span>tail</span>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([1, 2]);
  });

  it('accepts an id at int4 max', () => {
    const html = '<span data-type="blurb" data-id="2147483647">x</span>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([2147483647]);
  });

  it('rejects an id past int4 max', () => {
    const html = '<span data-type="blurb" data-id="2147483648">x</span>';
    expect(findBlurbSpans(html)).toHaveLength(0);
  });
});

describe('replaceBlurbSpans', () => {
  it('replaces inner content and leaves everything else byte-identical', () => {
    const html = '<p>before</p><span data-type="blurb" data-id="7">old</span><p>after</p>';
    const out = replaceBlurbSpans(html, new Map([[7, 'new']]));
    expect(out).toBe('<p>before</p><span data-type="blurb" data-id="7">new</span><p>after</p>');
  });

  it('replaces every occurrence of the same blurb', () => {
    const html =
      '<span data-type="blurb" data-id="7">old</span>x<span data-type="blurb" data-id="7">old</span>';
    const out = replaceBlurbSpans(html, new Map([[7, 'N']]));
    expect(out).toBe(
      '<span data-type="blurb" data-id="7">N</span>x<span data-type="blurb" data-id="7">N</span>'
    );
  });

  it('leaves spans whose id is not in the map untouched', () => {
    const html = '<span data-type="blurb" data-id="9">keep</span>';
    expect(replaceBlurbSpans(html, new Map([[7, 'N']]))).toBe(html);
  });

  it('returns the input unchanged when there are no blurb spans', () => {
    const html = '<p>nothing here</p>';
    expect(replaceBlurbSpans(html, new Map([[7, 'N']]))).toBe(html);
  });

  it('is a no-op when the replacement equals the current content', () => {
    const html = '<span data-type="blurb" data-id="7">same</span>';
    expect(replaceBlurbSpans(html, new Map([[7, 'same']]))).toBe(html);
  });

  it('lets the outer replacement win over a nested blurb span', () => {
    const html =
      '<span data-type="blurb" data-id="1">outer<span data-type="blurb" data-id="2">inner</span>tail</span>';
    const out = replaceBlurbSpans(
      html,
      new Map([
        [1, 'OUTER'],
        [2, 'INNER'],
      ])
    );
    expect(out).toBe('<span data-type="blurb" data-id="1">OUTER</span>');
  });

  it('does not duplicate trailing content after a self-closed blurb span', () => {
    const html = '<span data-type="blurb" data-id="7"/>after';
    expect(replaceBlurbSpans(html, new Map([[7, 'X']]))).toBe(html);
  });
});

describe('unwrapBlurbSpans', () => {
  it('removes the wrapper and keeps the text', () => {
    const html = '<p>a</p><span data-type="blurb" data-id="7">kept</span><p>b</p>';
    expect(unwrapBlurbSpans(html, new Set([7]))).toBe('<p>a</p>kept<p>b</p>');
  });

  it('only unwraps the ids it was given', () => {
    const html =
      '<span data-type="blurb" data-id="7">a</span><span data-type="blurb" data-id="8">b</span>';
    expect(unwrapBlurbSpans(html, new Set([7]))).toBe(
      'a<span data-type="blurb" data-id="8">b</span>'
    );
  });

  it('unwraps the outer span of a nested pair without corrupting the inner one', () => {
    const html =
      '<span data-type="blurb" data-id="1">outer<span data-type="blurb" data-id="2">inner</span>tail</span>';
    const out = unwrapBlurbSpans(html, new Set([1, 2]));
    expect(out).toBe('outer<span data-type="blurb" data-id="2">inner</span>tail');
  });
});

describe('renderBlurbSpan', () => {
  it('round-trips through findBlurbSpans', () => {
    const html = renderBlurbSpan(42, 'hello');
    const spans = findBlurbSpans(html);
    expect(spans).toHaveLength(1);
    expect(spans[0].blurbId).toBe(42);
    expect(html.slice(spans[0].innerStart, spans[0].innerEnd)).toBe('hello');
  });
});
