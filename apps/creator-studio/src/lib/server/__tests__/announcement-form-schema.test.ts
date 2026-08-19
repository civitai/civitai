import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowanceSchema, announcementFormSchema } from '../announcements-schema';

// A complete, valid submission as the action receives it — Object.fromEntries(FormData), so every
// value is a string. Each test overrides only the field it is about.
const form = (over: Record<string, unknown> = {}) => ({
  title: 'New LoRA out',
  content: 'It is trained on my own photos.',
  domain: 'blue',
  profileOnly: 'false',
  startsAt: '',
  endsAt: '',
  linkUrl: '',
  linkText: '',
  coverKey: '',
  ...over,
});

const parse = (over: Record<string, unknown> = {}) => announcementFormSchema.safeParse(form(over));

const messages = (over: Record<string, unknown> = {}) => {
  const result = parse(over);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('announcementFormSchema', () => {
  it('accepts a minimal submission', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domain).toEqual(['blue']);
      expect(result.data.profileOnly).toBe(false);
      expect(result.data.startsAt).toBeNull();
    }
  });

  it('splits the comma-joined domain field into an array', () => {
    const result = parse({ domain: 'blue,red' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domain).toEqual(['blue', 'red']);
  });

  it('rejects an empty domain and an unknown one', () => {
    expect(parse({ domain: '' }).success).toBe(false);
    expect(parse({ domain: 'purple' }).success).toBe(false);
  });

  it('reads the profile-only checkbox', () => {
    const result = parse({ profileOnly: 'on' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.profileOnly).toBe(true);
  });

  it('requires both halves of the button', () => {
    expect(messages({ linkUrl: 'https://civitai.com/models/1' })).toContain(
      'A button needs both a link and button text'
    );
    expect(messages({ linkText: 'Check it out' })).toContain(
      'A button needs both a link and button text'
    );
    expect(
      parse({ linkUrl: 'https://civitai.com/models/1', linkText: 'Check it out' }).success
    ).toBe(true);
  });

  it('rejects a button link that is not http(s)', () => {
    expect(messages({ linkUrl: 'javascript:alert(1)', linkText: 'Go' })).toContain(
      'Button link must start with http:// or https://'
    );
  });

  it('rejects an end date at or before the start date', () => {
    expect(messages({ startsAt: '2026-09-01T10:00', endsAt: '2026-08-01T10:00' })).toContain(
      'End date must be after the start date'
    );
    expect(parse({ startsAt: '2026-08-01T10:00', endsAt: '2026-09-01T10:00' }).success).toBe(true);
  });

  it('rejects a cover key that is not the uploader UUID', () => {
    expect(parse({ coverKey: 'some/object/key.png' }).success).toBe(false);
    expect(parse({ coverKey: '3f7b1f6e-2c2a-4a3f-9a3f-9d9f2c1b8a55' }).success).toBe(true);
  });

  it('rejects an empty subject or message', () => {
    expect(messages({ title: '   ' })).toContain('Add a subject');
    expect(messages({ content: '' })).toContain('Add a message');
  });
});

describe('the save action parses the whole form', () => {
  // A hand-listed safeParse input silently drops any field added to the schema later — the refines
  // above would then pass vacuously. Reading the route source is the only place that gap is visible.
  const source = readFileSync(
    fileURLToPath(new URL('../../../routes/(app)/announcements/+page.server.ts', import.meta.url)),
    'utf8'
  );

  it('reads its own source', () => {
    expect(source).toContain('announcementFormSchema');
  });

  it('feeds announcementFormSchema from Object.fromEntries', () => {
    expect(source).toContain('announcementFormSchema.safeParse(Object.fromEntries(form))');
  });
});

describe('allowanceSchema', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    eligible: false,
    tier: 'silver',
    score: 12_000,
    minScore: 10_000,
    used: 0,
    limit: 1,
    windowDays: 7,
    nextAvailableAt: null,
    ...over,
  });

  it('reads a well-formed allowance', () => {
    const result = allowanceSchema.safeParse(payload());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.score).toBe(12_000);
  });

  // The live endpoint returned `score: null` for a real creator — `Number(NaN)` serialises that way —
  // and the notice then crashed on `.toLocaleString()`.
  it('turns a null or non-finite count into 0 rather than passing it on', () => {
    for (const value of [null, undefined, 'not a number']) {
      const result = allowanceSchema.safeParse(payload({ score: value }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.score).toBe(0);
    }
  });

  // The live endpoint quotes the creator score.
  it('accepts a numeric string', () => {
    const result = allowanceSchema.safeParse(payload({ score: '444574' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.score).toBe(444574);
  });

  it('rejects a payload that is missing the fields the screens read', () => {
    expect(allowanceSchema.safeParse({ error: 'nope' }).success).toBe(false);
    expect(allowanceSchema.safeParse(payload({ eligible: 'yes' })).success).toBe(false);
  });

  // Coercing these to 0 would render a confident "no slots left" for a broken upstream, which the
  // creator cannot tell from a real exhaustion.
  it('fails rather than zeroes the counts the composer gates on', () => {
    for (const field of ['limit', 'windowDays']) {
      expect(allowanceSchema.safeParse(payload({ [field]: null })).success).toBe(false);
      expect(allowanceSchema.safeParse(payload({ [field]: 'lots' })).success).toBe(false);
    }
  });
});
