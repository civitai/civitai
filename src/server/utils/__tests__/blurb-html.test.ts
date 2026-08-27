import { describe, expect, it } from 'vitest';
import {
  findBlurbSpans,
  renderBlurbSpan,
  replaceBlurbSpans,
  unwrapBlurbSpans,
} from '~/server/utils/blurb-html';

describe('findBlurbSpans', () => {
  it('finds a simple span', () => {
    const html = '<p>a</p><div data-type="blurb" data-id="7">hi</div>';
    const spans = findBlurbSpans(html);
    expect(spans).toHaveLength(1);
    expect(spans[0].blurbId).toBe(7);
    expect(html.slice(spans[0].innerStart, spans[0].innerEnd)).toBe('hi');
  });

  it('finds spans whose content contains nested markup', () => {
    const html = '<div data-type="blurb" data-id="3"><strong>bo</strong><span>ld</span></div>';
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

  it('ignores an inline wrapper carrying the marker', () => {
    // A blurb is a `div`. A span wearing the attributes is not one, and matching it would have
    // the fan-out rewriting an element the editor never produced.
    expect(findBlurbSpans('<span data-type="blurb" data-id="7">x</span>')).toHaveLength(0);
  });

  it('ignores a blurb span with a non-numeric id', () => {
    expect(findBlurbSpans('<div data-type="blurb" data-id="abc">x</div>')).toHaveLength(0);
  });

  it('finds multiple spans in document order', () => {
    const html =
      '<div data-type="blurb" data-id="1">a</div>mid<div data-type="blurb" data-id="2">b</div>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([1, 2]);
  });

  it('orders a nested pair outer-first', () => {
    const html =
      '<div data-type="blurb" data-id="1">outer<div data-type="blurb" data-id="2">inner</div>tail</div>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([1, 2]);
  });

  it('accepts an id at int4 max', () => {
    const html = '<div data-type="blurb" data-id="2147483647">x</div>';
    expect(findBlurbSpans(html).map((s) => s.blurbId)).toEqual([2147483647]);
  });

  it('rejects an id past int4 max', () => {
    const html = '<div data-type="blurb" data-id="2147483648">x</div>';
    expect(findBlurbSpans(html)).toHaveLength(0);
  });
});

describe('replaceBlurbSpans', () => {
  it('replaces inner content and leaves everything else byte-identical', () => {
    const html = '<p>before</p><div data-type="blurb" data-id="7">old</div><p>after</p>';
    const out = replaceBlurbSpans(html, new Map([[7, 'new']]));
    expect(out).toBe('<p>before</p><div data-type="blurb" data-id="7">new</div><p>after</p>');
  });

  it('replaces every occurrence of the same blurb', () => {
    const html =
      '<div data-type="blurb" data-id="7">old</div>x<div data-type="blurb" data-id="7">old</div>';
    const out = replaceBlurbSpans(html, new Map([[7, 'N']]));
    expect(out).toBe(
      '<div data-type="blurb" data-id="7">N</div>x<div data-type="blurb" data-id="7">N</div>'
    );
  });

  it('leaves spans whose id is not in the map untouched', () => {
    const html = '<div data-type="blurb" data-id="9">keep</div>';
    expect(replaceBlurbSpans(html, new Map([[7, 'N']]))).toBe(html);
  });

  it('returns the input unchanged when there are no blurb spans', () => {
    const html = '<p>nothing here</p>';
    expect(replaceBlurbSpans(html, new Map([[7, 'N']]))).toBe(html);
  });

  it('is a no-op when the replacement equals the current content', () => {
    const html = '<div data-type="blurb" data-id="7">same</div>';
    expect(replaceBlurbSpans(html, new Map([[7, 'same']]))).toBe(html);
  });

  it('lets the outer replacement win over a nested blurb span', () => {
    const html =
      '<div data-type="blurb" data-id="1">outer<div data-type="blurb" data-id="2">inner</div>tail</div>';
    const out = replaceBlurbSpans(
      html,
      new Map([
        [1, 'OUTER'],
        [2, 'INNER'],
      ])
    );
    expect(out).toBe('<div data-type="blurb" data-id="1">OUTER</div>');
  });

  it('does not duplicate trailing content after a self-closed blurb span', () => {
    const html = '<div data-type="blurb" data-id="7"/>after';
    expect(replaceBlurbSpans(html, new Map([[7, 'X']]))).toBe(html);
  });
});

describe('unwrapBlurbSpans', () => {
  it('removes the wrapper and keeps the text', () => {
    const html = '<p>a</p><div data-type="blurb" data-id="7">kept</div><p>b</p>';
    expect(unwrapBlurbSpans(html, new Set([7]))).toBe('<p>a</p>kept<p>b</p>');
  });

  it('only unwraps the ids it was given', () => {
    const html =
      '<div data-type="blurb" data-id="7">a</div><div data-type="blurb" data-id="8">b</div>';
    expect(unwrapBlurbSpans(html, new Set([7]))).toBe(
      'a<div data-type="blurb" data-id="8">b</div>'
    );
  });

  it('unwraps the outer span of a nested pair without corrupting the inner one', () => {
    const html =
      '<div data-type="blurb" data-id="1">outer<div data-type="blurb" data-id="2">inner</div>tail</div>';
    const out = unwrapBlurbSpans(html, new Set([1, 2]));
    expect(out).toBe('outer<div data-type="blurb" data-id="2">inner</div>tail');
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
