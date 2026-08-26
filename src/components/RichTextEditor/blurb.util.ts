import type { Editor } from '@tiptap/react';
import { decode } from 'he';
import { removeTags } from '~/utils/string-helpers';

export type BlurbItem = {
  id: number;
  name: string;
  content: string;
};

/**
 * The preview in the manager and the picker is the on-screen stand-in for the snippet's own
 * words, so an un-decoded `&amp;` reads as a typo the creator cannot fix. `removeTags` only
 * strips tags.
 */
export function blurbPreview(content: string) {
  return decode(removeTags(content));
}

export function matchBlurbs(blurbs: BlurbItem[], query: string, limit = 8) {
  const normalized = query.trim().toLowerCase();
  const matched = !normalized
    ? blurbs
    : blurbs.filter(
        (blurb) =>
          blurb.name.toLowerCase().includes(normalized) ||
          blurbPreview(blurb.content).toLowerCase().includes(normalized)
      );
  return matched.slice(0, limit);
}

/**
 * The single writer of a blurb node's attrs. Three call sites insert one (`//` picker, toolbar,
 * manager row) and a key that misses `BlurbAttrs` yields an empty span the server re-expands
 * anyway — a failure that works by accident and reports nothing.
 */
export function insertBlurb(
  editor: Editor,
  blurb: Pick<BlurbItem, 'id' | 'content'>,
  replaceRange?: { from: number; to: number }
) {
  const chain = editor.chain().focus();
  if (replaceRange) chain.deleteRange(replaceRange);
  return chain.insertContent({ type: 'blurb', attrs: { id: blurb.id, text: blurb.content } }).run();
}
