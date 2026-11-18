import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Players meet the Order's ruling, never the mechanism behind it: "hidden check" stays internal.
const FILES = [
  './server/hidden/notices.ts',
  '../routes/play/+page.svelte',
  '../routes/judgments/+page.svelte',
  '../routes/home/+page.svelte',
];

describe('player-facing copy', () => {
  it.each(FILES)('%s never says "skill check"', (file) => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(text).not.toMatch(/skill[\s-]checks?/i);
  });
});
