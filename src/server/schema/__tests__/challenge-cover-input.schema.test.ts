import { describe, expect, it } from 'vitest';
import { challengeCoverInputSchema } from '~/server/schema/challenge.schema';

describe('a challenge or event cover on save', () => {
  it('🔴 accepts the stored cover as the edit views send it, by id with no url', () => {
    const parsed = challengeCoverInputSchema.safeParse({ id: 80, url: '', restricted: false });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ id: 80 });
  });

  it('still refuses an empty url without an id, or a url that is no upload (control)', () => {
    expect(challengeCoverInputSchema.safeParse({ url: '' }).success).toBe(false);
    expect(challengeCoverInputSchema.safeParse({ url: 'not-a-key' }).success).toBe(false);
  });

  it('accepts an uploaded cover (control)', () => {
    expect(
      challengeCoverInputSchema.safeParse({ url: '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b' }).success
    ).toBe(true);
  });
});
