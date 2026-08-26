import type { Editor } from '@tiptap/react';
import { decode } from 'he';
import { getDisplayName, removeTags } from '~/utils/string-helpers';

export type BlurbItem = {
  id: number;
  name: string;
  content: string;
  referenceCount: number;
  referencesByEntityType: Record<string, number>;
};

/**
 * The chip in the editor is the on-screen stand-in for the blurb's own words, so an
 * un-decoded `&amp;` reads as a typo the creator cannot fix. `removeTags` only strips tags.
 */
export function blurbPreview(content: string) {
  return decode(removeTags(content));
}

export function usesLabel(count: number) {
  if (count === 0) return 'Not used yet';
  return count === 1 ? '1 use' : `${count} uses`;
}

export function placesLabel(count: number) {
  return count === 1 ? '1 place' : `${count} places`;
}

/**
 * Creator-facing names per `BlurbReference.entityType`. Explicit rather than derived: the
 * sentence these feed is the one telling a creator the edit is not local, and `Bounty` +
 * a naive `s` reads `bountys`.
 */
const entityNouns: Record<string, { one: string; many: string }> = {
  Article: { one: 'article', many: 'articles' },
  Model: { one: 'model', many: 'models' },
  ModelVersion: { one: 'model version', many: 'model versions' },
  Bounty: { one: 'bounty', many: 'bounties' },
  Challenge: { one: 'challenge', many: 'challenges' },
  Changelog: { one: 'changelog entry', many: 'changelog entries' },
  CosmeticShopItem: { one: 'shop item', many: 'shop items' },
};

function entityNoun(entityType: string, count: number) {
  const known = entityNouns[entityType];
  if (known) return count === 1 ? known.one : known.many;

  const derived = getDisplayName(entityType).toLowerCase();
  if (count === 1) return derived;
  if (/[^aeiou]y$/.test(derived)) return `${derived.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(derived)) return `${derived}es`;
  return `${derived}s`;
}

/** `38 models, 2 articles, 1 bounty` — the per-surface reach shown before an edit is saved. */
export function usageBreakdown(referencesByEntityType: Record<string, number>) {
  return Object.entries(referencesByEntityType)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([entityType, count]) => `${count} ${entityNoun(entityType, count)}`)
    .join(', ');
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
