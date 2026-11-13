import type { Editor } from '@tiptap/core';
import { Node, mergeAttributes, nodePasteRule } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import type { CivitaiEmbedItem } from '~/shared/tiptap/civitai-embed.utils';
import {
  getCivitaiEmbedHref,
  parseCivitaiEmbedUrl,
  toCivitaiEmbedItem,
} from '~/shared/tiptap/civitai-embed.utils';

export type CivitaiEmbedAttrs = { items: CivitaiEmbedItem[] };

// A line that is nothing but a model, version or image link.
export const CIVITAI_EMBED_PASTE_URL =
  /^https?:\/\/(?:www\.)?civitai\.(?:com|red|green|blue)\/(?:models\/\d+[^\s]*|images\/\d+\/?)$/g;

function readItems(el: HTMLElement): CivitaiEmbedItem[] {
  return Array.from(el.querySelectorAll('a[data-entity]'))
    .map((a) =>
      toCivitaiEmbedItem({
        type: a.getAttribute('data-entity'),
        id: a.getAttribute('data-id'),
        versionId: a.getAttribute('data-version-id') ?? undefined,
      })
    )
    .filter((item): item is CivitaiEmbedItem => !!item);
}

/**
 * Stores only `{type, id, versionId?}`; everything a reader sees loads at view time through their
 * own browsing filters. Serialized as plain links so any surface that doesn't know the node still
 * shows something that works.
 */
export const CivitaiEmbedNode = Node.create<{ pasteToCard: boolean }>({
  name: 'civitaiEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { pasteToCard: false };
  },

  addAttributes() {
    return {
      items: {
        default: [],
        parseHTML: (el) => readItems(el as HTMLElement),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="civitaiEmbed"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The href is rebuilt from the ids rather than kept from the input, so it cannot point
    // anywhere the ids don't.
    const links: DOMOutputSpec[] = ((node.attrs.items ?? []) as unknown[])
      .map(toCivitaiEmbedItem)
      .filter((item): item is CivitaiEmbedItem => !!item)
      .map((item) => {
        const href = getCivitaiEmbedHref(item);
        return [
          'a',
          {
            href,
            'data-entity': item.type,
            'data-id': String(item.id),
            ...(item.versionId ? { 'data-version-id': String(item.versionId) } : {}),
          },
          href,
        ];
      });
    return ['div', mergeAttributes({ 'data-type': 'civitaiEmbed' }, HTMLAttributes), ...links];
  },

  renderText({ node }) {
    return ((node.attrs.items ?? []) as CivitaiEmbedItem[]).map(getCivitaiEmbedHref).join('\n');
  },

  addPasteRules() {
    if (!this.options.pasteToCard) return [];
    return [
      nodePasteRule({
        find: CIVITAI_EMBED_PASTE_URL,
        type: this.type,
        getAttributes: (match) => {
          const item = parseCivitaiEmbedUrl(match[0]);
          return { items: item ? [item] : [] };
        },
      }),
    ];
  },
});

/** The model or image an Embed dialog input can become a card of, behind the same gate as paste. */
export function civitaiCardFromInput(editor: Editor, input: string): CivitaiEmbedItem | null {
  const node = editor.extensionManager.extensions.find((ext) => ext.name === CivitaiEmbedNode.name);
  return node?.options.pasteToCard ? parseCivitaiEmbedUrl(input) : null;
}
