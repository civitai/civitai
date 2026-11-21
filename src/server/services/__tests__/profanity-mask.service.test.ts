import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { describe, expect, it, vi } from 'vitest';
import { createProfanityFilter } from '~/libs/profanity-simple';
import type * as FliptClient from '~/server/flipt/client';

// Flag off: the shipped lists, so a word from the shipped file is masked.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => false,
}));

import {
  maskProfanityInChat,
  maskProfanityInHtml,
  withMaskedChatContent,
  withMaskedChatPreviews,
  withMaskedDetails,
} from '~/server/services/profanity-mask.service';

// A shipped entry read at runtime, never written down: this repository is public.
const WORD = blockedWords
  .map(cleanWord)
  .find(
    (word) =>
      isUsableBlockedEntry(word) &&
      !word.includes('|') &&
      createProfanityFilter().clean(word) !== word
  ) as string;
const CLEAN = 'a perfectly ordinary sentence';

describe('maskProfanityInHtml', () => {
  it('masks the visible text, keeps the markup, and is null for clean text', async () => {
    const [masked, clean, empty] = await maskProfanityInHtml([
      `<p class="x">hello <b>${WORD}</b></p>`,
      `<p>${CLEAN}</p>`,
      '',
    ]);
    expect(masked).toMatch(/^<p class="x">hello <b>\*+<\/b><\/p>$/);
    expect(masked).not.toContain(WORD);
    expect(clean).toBeNull();
    expect(empty).toBeNull();
  });

  // Long text is masked as it is today, never left raw or blurred for its length (#9952).
  // To whoever adds a length cap: that was considered and declined.
  it('masks text of any length, with no cap', async () => {
    const long = `<p>${'word '.repeat(60_000)}${WORD}</p>`;
    const [masked] = await maskProfanityInHtml([long]);
    expect(long.length).toBeGreaterThan(200_000);
    expect(masked).not.toBeNull();
    expect(masked).not.toContain(WORD);
  });
});

describe('maskProfanityInChat', () => {
  it('masks across a sticker token, which a per-run mask would let through', async () => {
    const half = Math.floor(WORD.length / 2);
    const split = `${WORD.slice(0, half)}:sticker:1:${WORD.slice(half)}`;
    const [masked, clean] = await maskProfanityInChat([split, CLEAN]);
    expect(masked).not.toBeNull();
    expect(masked).not.toContain(WORD);
    expect(masked).not.toContain(':sticker:');
    expect(clean).toBeNull();
  });
});

describe('the item helpers', () => {
  it('add the masked copy beside each text, in order', async () => {
    const reviews = await withMaskedDetails([
      { id: 1, details: `<p>${WORD}</p>` },
      { id: 2, details: null },
    ]);
    expect(reviews.map((r) => [r.id, r.maskedDetails === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    const messages = await withMaskedChatContent([
      { id: 3, content: CLEAN },
      { id: 4, content: WORD },
    ]);
    expect(messages.map((m) => [m.id, m.maskedContent === null])).toEqual([
      [3, true],
      [4, false],
    ]);
  });
});

describe('withMaskedChatPreviews', () => {
  it('gives each chat back its own messages, masked, in order', async () => {
    const chats = await withMaskedChatPreviews([
      { id: 1, messages: [{ content: CLEAN }] },
      { id: 2, messages: [] },
      { id: 3, messages: [{ content: WORD }, { content: 'second clean line' }] },
    ]);
    expect(
      chats.map((chat) => [
        chat.id,
        chat.messages.map((m) => [m.content, m.maskedContent === null]),
      ])
    ).toEqual([
      [1, [[CLEAN, true]]],
      [2, []],
      [
        3,
        [
          [WORD, false],
          ['second clean line', true],
        ],
      ],
    ]);
  });
});
