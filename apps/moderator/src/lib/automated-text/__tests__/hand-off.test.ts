import { describe, expect, it } from 'vitest';
import { handOffLinks, resolveHandOffs, type HandOffDeps, type HandOffItem } from '../hand-off';
import { maskChatSpeakers, needsHandOff, parseTextLabel } from '../labels';

const SITE = 'https://civitai.example';

const item = (over: Partial<HandOffItem> = {}): HandOffItem => ({
  token: 't',
  tag: 'CSAM',
  answeredAt: new Date('2026-10-04T00:00:00Z'),
  reportId: 42,
  entityType: 'commentV2',
  entityId: 7,
  authorId: 9,
  ...over,
});

describe('handOffLinks', () => {
  // The page must never be a dead end for a real case: every hand-off opens the Automated report
  // itself, where a moderator can action it whatever its status.
  it('opens the report, the comment in its thread and the author', () => {
    expect(
      handOffLinks(SITE, { ...item(), contextUrl: '/posts/3?highlight=7' }).map((l) => l.href)
    ).toEqual([
      '/reports/comment?report=42',
      `${SITE}/posts/3?highlight=7`,
      expect.stringContaining('9'),
    ]);
  });

  // A legacy model comment has no page of its own; without its context URL it would get no content
  // link at all.
  it('links a legacy model comment through its context URL', () => {
    const links = handOffLinks(SITE, {
      ...item({ entityType: 'comment' }),
      contextUrl: '/models/1?dialog=commentThread&highlight=7',
    });
    expect(links.find((l) => l.label === 'Open the content')?.href).toBe(
      `${SITE}/models/1?dialog=commentThread&highlight=7`
    );
  });

  it('opens a chat in Chat Audit, since a chat has no page on the site', () => {
    const links = handOffLinks(SITE, item({ entityType: 'chat', entityId: 5, authorId: null }));
    expect(links).toEqual([
      { label: 'Open the report', href: '/reports/chat?report=42', external: false },
      { label: 'Open the content', href: '/retool/chat-audit/chats?chat=5', external: false },
    ]);
  });

  it('still offers the author when the entity is gone', () => {
    expect(
      handOffLinks(SITE, item({ entityType: 'unknown', entityId: null, authorId: 3 })).map(
        (l) => l.label
      )
    ).toEqual(['Author in User Lookup']);
  });
});

describe('resolveHandOffs', () => {
  const resolve = (
    canOpen: (path: string) => boolean,
    over: Partial<HandOffItem> = {},
    lookup: HandOffDeps['lookup'] = async () => ({
      reachable: true,
      contextUrl: '/posts/3?highlight=7',
    })
  ) => resolveHandOffs([item(over)], { civitaiUrl: SITE, canOpen, lookup }).then((r) => r[0]);

  // A labeller granted only this page would otherwise be handed links that all end at a 403.
  it('names the links this viewer cannot open instead of offering them', async () => {
    const r = await resolve(() => false);
    expect(r.links.map((l) => l.label)).toEqual(['Open the content']);
    expect(r.blocked).toEqual(['Open the report', 'Author in User Lookup']);
    expect(r.reportId).toBe(42);
  });

  it('offers every link to a viewer with the grants', async () => {
    const r = await resolve(() => true);
    expect(r.links.map((l) => l.label)).toEqual([
      'Open the report',
      'Open the content',
      'Author in User Lookup',
    ]);
    expect(r.blocked).toEqual([]);
  });

  it('flags a report whose content was gone at snapshot', async () => {
    expect((await resolve(() => true, { entityType: 'unknown' })).contentGone).toBe(true);
  });

  // Items are served for weeks after the snapshot. Content deleted in that time takes its report's
  // join row with it, and the report page can no longer show the report.
  it('drops the report link when the content was deleted after the snapshot', async () => {
    const r = await resolve(
      () => true,
      {},
      async () => ({ reachable: false, contextUrl: null })
    );
    expect(r.contentGone).toBe(true);
    expect(r.links.map((l) => l.label)).toEqual(['Author in User Lookup']);
  });

  // A failed lookup is not evidence the content is gone; offering the links is the safer miss.
  it('keeps the links when the lookup fails', async () => {
    const r = await resolve(
      () => true,
      {},
      async () => null
    );
    expect(r.contentGone).toBe(false);
    expect(r.links.map((l) => l.label)).toEqual(['Open the report', 'Author in User Lookup']);
  });
});

describe('labels', () => {
  it('accepts only the four stored values', () => {
    expect(
      ['clear_violation', 'borderline', 'false_positive', 'cannot_tell'].map(parseTextLabel)
    ).toEqual(['clear_violation', 'borderline', 'false_positive', 'cannot_tell']);
    expect(parseTextLabel('violation')).toBeNull();
    expect(parseTextLabel(null)).toBeNull();
  });

  it('hands off a clear violation on CSAM or Grooming only', () => {
    expect(needsHandOff('CSAM', 'clear_violation')).toBe(true);
    expect(needsHandOff('Grooming', 'clear_violation')).toBe(true);
    expect(needsHandOff('CSAM', 'borderline')).toBe(false);
    expect(needsHandOff('NSFW', 'clear_violation')).toBe(false);
  });
});

describe('maskChatSpeakers', () => {
  it('replaces each author id with a letter in order of first appearance', () => {
    expect(maskChatSpeakers('[30]: a | [12]: b | [30]: c | [7]: d')).toBe(
      '[Speaker A]: a | [Speaker B]: b | [Speaker A]: c | [Speaker C]: d'
    );
  });

  it('leaves a bracketed number inside a message alone', () => {
    expect(maskChatSpeakers('[30]: see [2]: below')).toBe('[Speaker A]: see [2]: below');
  });
});
