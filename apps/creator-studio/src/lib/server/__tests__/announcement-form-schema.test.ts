import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowanceSchema, announcementFormSchema } from '../announcements-schema';
import { CONTENT_CEILING, DOMAIN_CHIPS } from '../../announcements';

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

  it('accepts a site-relative path, so a link resolves on whichever site the reader is on', () => {
    const result = parse({ linkUrl: '/models/123', linkText: 'See the model' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.linkUrl).toBe('/models/123');
  });

  it('rejects links that leave the site while looking like they do not', () => {
    const bad = 'Button link must be a full https:// URL or a path like /models/123';
    // Protocol-relative: reads as a path, resolves to another host.
    expect(messages({ linkUrl: '//evil.example/models', linkText: 'Go' })).toContain(bad);
    expect(messages({ linkUrl: 'javascript:alert(1)', linkText: 'Go' })).toContain(bad);
    expect(messages({ linkUrl: 'models/123', linkText: 'Go' })).toContain(bad);
  });

  // The composer converts the picker's wall-clock value to an instant in the creator's browser, so
  // the action must read a zoned value and never re-interpret a bare local string in the server's
  // zone. A UTC+10 creator picking 10:00 must not be stored as 10:00 UTC.
  it('stores the instant the creator picked, not a server reading of the wall clock', () => {
    const result = parse({ startsAt: '2026-09-01T10:00:00.000+10:00' });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.startsAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rejects an unparseable date rather than storing an invalid one', () => {
    expect(parse({ startsAt: 'sometime next week' }).success).toBe(false);
  });

  it('passes an inverted window through for the server to clamp', () => {
    const result = parse({
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startsAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
      expect(result.data.endsAt?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    }
  });

  // A migrated profile banner can already exceed CONTENT_MAX through no act of its owner. Capping
  // this form at CONTENT_MAX refused it before it ever reached the main app, which is the thing that
  // decides whether an over-long row may be saved — so the owner could not edit their own card.
  it('passes an over-limit legacy body through for the main app to judge', () => {
    const legacy = 'y'.repeat(900);
    const result = parse({ content: legacy });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe(legacy);
  });

  it('still refuses a body past the hard ceiling', () => {
    expect(parse({ content: 'y'.repeat(CONTENT_CEILING + 1) }).success).toBe(false);
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

// The colour names do not match the sites they serve, and one colour is unreachable, so the picker's
// mapping is the kind of thing that has to be pinned rather than read.
describe('domain chips', () => {
  it('maps each site to the colour that actually serves it', () => {
    expect(DOMAIN_CHIPS.map((c) => [c.host, c.color])).toEqual([
      ['civitai.com', 'green'],
      ['civitai.red', 'blue'],
    ]);
  });

  // SERVER_DOMAIN_RED is also civitai.red and getRequestDomainColor takes the first match of
  // ['green','blue','red'], so a row written as `red` is valid, saves, and is then invisible.
  it('cannot express `red`, which no request resolves to', () => {
    // Widened to string on purpose: the chip type no longer INCLUDES 'red', so comparing
    // against it is a type error rather than a false assertion. That the type excludes it is
    // the stronger guarantee; this keeps the runtime check honest without pretending the
    // comparison is possible.
    expect(DOMAIN_CHIPS.some((c) => (c.color as string) === 'red')).toBe(false);
  });

  it('offers no everywhere chip, since both chips already are everywhere', () => {
    expect(DOMAIN_CHIPS).toHaveLength(2);
    expect(DOMAIN_CHIPS.some((c) => (c.color as string) === 'all')).toBe(false);
  });
});
