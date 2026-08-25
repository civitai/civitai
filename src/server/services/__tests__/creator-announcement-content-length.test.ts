import { describe, it, expect } from 'vitest';
import { assertContentLength } from '~/server/services/creator-announcement.service';
import {
  CREATOR_ANNOUNCEMENT_CONTENT_CEILING,
  CREATOR_ANNOUNCEMENT_CONTENT_MAX,
} from '~/server/schema/announcement.schema';

const text = (length: number) => 'x'.repeat(length);
const OVER = CREATOR_ANNOUNCEMENT_CONTENT_MAX + 1;

describe('new content is held to the limit', () => {
  it('accepts content at the limit', () => {
    expect(() => assertContentLength(text(CREATOR_ANNOUNCEMENT_CONTENT_MAX))).not.toThrow();
  });

  it('refuses content one character over', () => {
    expect(() => assertContentLength(text(OVER))).toThrow(
      new RegExp(String(CREATOR_ANNOUNCEMENT_CONTENT_MAX))
    );
  });
});

describe('a row that was already over the limit stays editable', () => {
  // The pending profile-banner backfill inserts rows from UserProfile.message, thousands of which
  // are longer than the limit. Refusing every save would leave those creators unable to touch
  // their own card — the revert this catches is dropping the previousContent branch.
  it('allows an over-limit legacy row to be saved unchanged', () => {
    const legacy = text(900);
    expect(() => assertContentLength(legacy, legacy)).not.toThrow();
  });

  it('allows an over-limit legacy row to be shortened but still over', () => {
    expect(() => assertContentLength(text(700), text(900))).not.toThrow();
  });

  it('refuses growing an over-limit legacy row', () => {
    expect(() => assertContentLength(text(901), text(900))).toThrow();
  });

  it('does not let a short row grow past the limit just because it has a previous value', () => {
    // The bug this catches is comparing against the limit instead of against the previous length:
    // an ordinary edit must not inherit the legacy allowance.
    expect(() => assertContentLength(text(OVER), text(100))).toThrow();
  });
});

describe('the limit itself', () => {
  it('is 500 — the card has no line clamp, so this is what renders in full', () => {
    expect(CREATOR_ANNOUNCEMENT_CONTENT_MAX).toBe(500);
  });

  it('is the same number the creator-studio composer counts against', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../../apps/creator-studio/src/lib/announcements.ts', import.meta.url)
      ),
      'utf8'
    );

    const declared = source.match(/export const CONTENT_MAX = (\d+);/)?.[1];

    expect(declared, 'CONTENT_MAX not found in the creator-studio source').toBeDefined();
    expect(Number(declared)).toBe(CREATOR_ANNOUNCEMENT_CONTENT_MAX);
  });

  // The spoke form must accept anything the main app might still allow, or a legacy over-limit row
  // is refused before it ever reaches the grandfather branch above.
  it('is matched by a creator-studio ceiling no lower than ours', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../../apps/creator-studio/src/lib/announcements.ts', import.meta.url)
      ),
      'utf8'
    );

    const declared = source.match(/export const CONTENT_CEILING = (\d+);/)?.[1];

    expect(declared, 'CONTENT_CEILING not found in the creator-studio source').toBeDefined();
    expect(Number(declared)).toBe(CREATOR_ANNOUNCEMENT_CONTENT_CEILING);
  });
});
