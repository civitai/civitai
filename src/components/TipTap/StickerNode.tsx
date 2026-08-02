import { InputRule } from '@tiptap/core';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { getStickerSuggestions } from '~/components/RichTextEditor/sticker-suggestion';
import { Sticker } from '~/components/Sticker/Sticker';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { StickerNode } from '~/shared/tiptap/sticker.node';
import { isValidStickerSlug, STICKER_SLUG_PATTERN } from '~/shared/utils/sticker-token';

export type StickerNodeStorage = {
  /**
   * Owned stickers with uses left, kept current by `RichTextEditorComponent`.
   * Held in per-editor storage rather than extension options so that ownership
   * arriving asynchronously doesn't change the extension array and rebuild the
   * editor under someone who is mid-sentence.
   */
  available: ResolvedSticker[];
};

declare module '@tiptap/core' {
  interface Storage {
    sticker: StickerNodeStorage;
  }
}

/**
 * `:slug:` typed out in full, at the cursor. The lookbehind mirrors the
 * autocomplete's `allowedPrefixes` so the two insertion paths agree on what is
 * insertable — without it `foo:gumdong_heart:` converts while the menu correctly
 * refuses the same position. Shape comes from the shared pattern; validity is
 * checked explicitly below rather than left to the shape.
 */
const inputRegex = new RegExp(String.raw`(?<![^\s])` + `:(${STICKER_SLUG_PATTERN}):$`);

/**
 * Editor-side sticker node: same schema as the shared `StickerNode`, plus a React
 * node view, `:` autocomplete, and an input rule for a fully-typed `:slug:`.
 *
 * The input rule is not a convenience. Autocomplete teaches the `:slug:` syntax,
 * which works as plain text in chat but is inert in comments — the consumption
 * counter is span-only by design. Someone who learns it in chat and types it into
 * a comment would otherwise get text that renders as nothing and costs nothing,
 * looking correct until they post. Both spellings have to produce the node.
 */
export const StickerEditNode = StickerNode.extend<unknown, StickerNodeStorage>({
  addStorage() {
    return { available: [] };
  },

  addNodeView() {
    return ReactNodeViewRenderer(StickerEditComponent);
  },

  addInputRules() {
    return [
      new InputRule({
        find: inputRegex,
        handler: ({ state, range, match }) => {
          // Explicit, not incidental: `12:30:` fits the slug shape, and the only
          // thing rejecting it is the all-digits rule inside isValidStickerSlug.
          // Calling it here keeps that dependency visible and shared.
          if (!isValidStickerSlug(match[1])) return;
          // Ownership is checked here as well as server-side: the server strips a
          // node you don't own, so without this the editor would show it working
          // and the sticker would vanish on save.
          const owned = this.storage.available.find((x) => x.slug === match[1]);
          if (!owned) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ id: String(owned.id), slug: owned.slug })
          );
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...getStickerSuggestions(() => this.storage.available),
      }),
    ];
  },
});

function StickerEditComponent({ node }: ReactNodeViewProps<HTMLSpanElement>) {
  const { id } = node.attrs as { id: string };
  return (
    <NodeViewWrapper as="span" data-drag-handle style={{ display: 'inline' }}>
      <Sticker cosmeticId={Number(id)} />
    </NodeViewWrapper>
  );
}
