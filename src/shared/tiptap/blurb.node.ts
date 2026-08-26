import { Node, mergeAttributes } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import { Parser } from 'htmlparser2';

export type BlurbAttrs = { id: number | null; text: string };

type SpecAttrs = Record<string, string>;
type SpecNode = Array<string | SpecAttrs | SpecNode>;

/**
 * The stored interior markup as a ProseMirror output spec, so the serializer emits real elements.
 *
 * Not a DOM build: `@tiptap/html/server` serializes through zeed-dom, where there is no global
 * `document`, and that is the path `generateHTML` takes off the browser.
 *
 * `decodeEntities` matters as much as the tags do — a text node is re-escaped on the way out, so a
 * stored `&amp;` passed through raw would come back `&amp;amp;`, the same compounding this exists
 * to stop.
 */
function blurbInteriorSpec(html: string): DOMOutputSpec[] {
  const root: SpecNode = [];
  const stack: SpecNode[] = [root];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const element: SpecNode = [name];
        if (Object.keys(attribs).length) element.push(attribs);
        stack[stack.length - 1].push(element);
        stack.push(element);
      },
      ontext(text) {
        if (text) stack[stack.length - 1].push(text);
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true }
  );
  parser.write(html);
  parser.end();
  return root as DOMOutputSpec[];
}

// Atomic and not editable in place: the text inside a blurb is owned by the blurb, and
// hand-editing one copy would drift from the row until the next fan-out silently reverted it.
//
// Block rather than inline, which is what lets a blurb hold headings and lists. As an inline
// `<span>` it could not: the span sits inside the host's `<p>`, and in the HTML parsing algorithm
// a block start tag closes that paragraph and pops the span rather than reconstructing it, so the
// blurb rendered EMPTY and its words landed as a detached sibling — which the next save then
// re-spliced, printing them twice.
export const BlurbNode = Node.create({
  name: 'blurb',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => {
          const raw = (el as HTMLElement).getAttribute('data-id');
          return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
        },
        renderHTML: (attrs) => (attrs.id ? { 'data-id': String(attrs.id) } : {}),
      },
      text: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).innerHTML,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // `span` is the shape blurbs were stored in before they could hold blocks. Parsing it here is
    // the whole migration: an old body opened in an editor comes back out as a `div` on save.
    return [{ tag: 'div[data-type="blurb"]' }, { tag: 'span[data-type="blurb"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The text is emitted as the wrapper's markup, which is what puts the materialised form in
    // editor.getHTML() and therefore in the stored column.
    //
    // 🔴 Element children, not `['span', attrs, text]`. ProseMirror turns a string child into a
    // TEXT node, so `<strong>` would be escaped on the way out — and `parseHTML` reads
    // `innerHTML`, so every open-and-save escapes the escape (`&lt;` -> `&amp;lt;`). With the
    // flag off nothing re-expands it, so the literal tags render on the page.
    //
    // `data-type` first because mergeAttributes emits first-argument keys first, which is the
    // shape blurb.node.test.ts round-trips. It does not protect the VALUE — a later argument wins
    // a key collision.
    const spec: [string, SpecAttrs, ...DOMOutputSpec[]] = [
      'div',
      mergeAttributes({ 'data-type': 'blurb' }, HTMLAttributes),
      ...blurbInteriorSpec(node.attrs.text ?? ''),
    ];
    return spec;
  },

  renderText({ node }) {
    return node.attrs.text ?? '';
  },
});
