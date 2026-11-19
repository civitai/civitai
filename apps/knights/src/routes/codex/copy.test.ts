import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const copy = [read('./+page.svelte'), read('./RankLadder.svelte')].join('\n').toLowerCase();

describe('codex copy', () => {
  it.each([
    'skill check',
    'vote weight',
    'weight of your votes',
    'consensus',
    'moderator',
    'smite',
    'escalat',
    'majority',
  ])('says nothing of %s, which is behind the scenes', (internal) => {
    expect(copy).not.toContain(internal);
  });

  it('explains what a player needs to play', () => {
    for (const topic of [
      'pending',
      'inconclusive',
      'forfeited',
      'vigil',
      'shield',
      'buzz',
      'hearts',
    ]) {
      expect(copy).toContain(topic);
    }
  });
});
