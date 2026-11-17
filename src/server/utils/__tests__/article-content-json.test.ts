import { describe, expect, it } from 'vitest';
import { articleContentJson } from '~/server/utils/article-content-json';

type Doc = {
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Doc[];
};

function textStyleAttrs(node: Doc): Record<string, unknown>[] {
  return [
    ...(node.marks ?? []).filter((m) => m.type === 'textStyle').map((m) => m.attrs ?? {}),
    ...(node.content ?? []).flatMap(textStyleAttrs),
  ];
}

const span = (style: string) => `<p><span style="${style.replace(/"/g, '&quot;')}">x</span></p>`;

describe('articleContentJson text-style marks', () => {
  it('keeps in-bounds values for every text-style attribute', () => {
    const [attrs] = textStyleAttrs(
      articleContentJson(
        span(
          'color: rgb(250, 82, 82); background-color: #fab005; font-size: 18px; line-height: 1.5; font-family: "Segoe UI", sans-serif'
        )
      )
    );
    expect(attrs).toMatchObject({
      color: 'rgb(250, 82, 82)',
      backgroundColor: '#fab005',
      fontSize: '18px',
      lineHeight: '1.5',
    });
    expect(attrs.fontFamily).toMatch(/Segoe UI/);
  });

  it('clears out-of-bounds values and keeps the rest', () => {
    const [attrs] = textStyleAttrs(
      articleContentJson(
        span(
          'color: rgb(250, 82, 82); background-color: var(--x); font-size: 5000px; line-height: 40; font-family: url(x)'
        )
      )
    );
    expect(attrs).toMatchObject({
      color: 'rgb(250, 82, 82)',
      backgroundColor: null,
      fontSize: null,
      lineHeight: null,
      fontFamily: null,
    });
  });

  it('applies to nested content', () => {
    const attrs = textStyleAttrs(
      articleContentJson(
        `<ul><li><p><span style="font-size: 5000px">a</span></p></li></ul>${span(
          'font-size: 12px'
        )}`
      )
    );
    expect(attrs.map((a) => a.fontSize)).toEqual([null, '12px']);
  });

  it('drops class from link marks and keeps the href', () => {
    const doc = articleContentJson(
      '<p><a href="https://civitai.com/x" class="a b">x</a></p>'
    ) as Doc;
    const [link] = (doc.content?.[0].content?.[0].marks ?? []).filter((m) => m.type === 'link');
    expect(link.attrs).toMatchObject({ href: 'https://civitai.com/x', class: null });
  });
});
