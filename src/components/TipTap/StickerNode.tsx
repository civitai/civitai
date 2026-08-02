import { InputRule } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useState } from 'react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { getStickerSuggestions } from '~/components/RichTextEditor/sticker-suggestion';
import { Sticker } from '~/components/Sticker/Sticker';
import type { AvailableSticker } from '~/components/Sticker/sticker.util';
import { StickerNode } from '~/shared/tiptap/sticker.node';
import {
  isValidStickerSlug,
  STICKER_JUMBO_LIMIT,
  STICKER_SIZE,
  STICKER_SLUG_PATTERN,
} from '~/shared/utils/sticker-token';

export type StickerNodeStorage = {
  /**
   * Owned stickers with uses left, kept current by `RichTextEditorComponent`.
   * Held in per-editor storage rather than extension options so that ownership
   * arriving asynchronously doesn't change the extension array and rebuild the
   * editor under someone who is mid-sentence.
   */
  available: AvailableSticker[];
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

/**
 * Same rule the chat and comment renderers apply: a block holding nothing but
 * stickers draws them large. Re-derived from the document rather than shared with
 * `parseStickerLines`, which reads a token string — here the source of truth is
 * the ProseMirror node.
 */
function isJumboBlock(parent: PMNode) {
  let stickers = 0;
  let hasOtherContent = false;
  parent.forEach((child) => {
    if (child.type.name === 'sticker') stickers++;
    else if (child.isText ? !!child.text?.trim() : true) hasOtherContent = true;
  });
  return !hasOtherContent && stickers > 0 && stickers <= STICKER_JUMBO_LIMIT;
}

function StickerEditComponent({ node, editor, getPos }: ReactNodeViewProps<HTMLSpanElement>) {
  const { id } = node.attrs as { id: string };
  const [jumbo, setJumbo] = useState(false);

  // Typing beside a sticker changes its parent block without changing the node
  // itself, so the node view doesn't re-render on its own — recompute per
  // transaction or the size sticks at whatever it was when first drawn.
  useEffect(() => {
    const update = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (pos == null) return;
      try {
        setJumbo(isJumboBlock(editor.state.doc.resolve(pos).parent));
      } catch {
        // Position can be stale mid-transaction; the next one resolves it.
      }
    };
    update();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor, getPos]);

  return (
    <NodeViewWrapper as="span" data-drag-handle style={{ display: 'inline' }}>
      <Sticker cosmeticId={Number(id)} size={jumbo ? STICKER_SIZE.jumbo : STICKER_SIZE.inline} />
    </NodeViewWrapper>
  );
}
