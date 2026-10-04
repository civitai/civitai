import { describe, expect, it } from 'vitest';
import { handOffLinks } from '../hand-off';
import { needsHandOff, parseTextLabel } from '../labels';

const SITE = 'https://civitai.example';

describe('handOffLinks', () => {
  // The page must never be a dead end for a real case: every hand-off opens the Automated report
  // itself, where a moderator can action it whatever its status.
  it('opens the report, the comment and the author for a comment hit', () => {
    expect(
      handOffLinks(SITE, { reportId: 42, entityType: 'commentV2', entityId: 7, authorId: 9 })
    ).toEqual([
      { label: 'Open the report', href: '/reports/comment?report=42', external: false },
      { label: 'Open the content', href: `${SITE}/comments/v2/7`, external: true },
      { label: 'Author in User Lookup', href: expect.stringContaining('9'), external: false },
    ]);
  });

  it('opens a chat in Chat Audit, since a chat has no page on the site', () => {
    const links = handOffLinks(SITE, {
      reportId: 1,
      entityType: 'chat',
      entityId: 5,
      authorId: null,
    });
    expect(links).toEqual([
      { label: 'Open the report', href: '/reports/chat?report=1', external: false },
      { label: 'Open the content', href: '/retool/chat-audit/chats?chat=5', external: false },
    ]);
  });

  it('still offers the author when the entity type is unknown', () => {
    expect(
      handOffLinks(SITE, { reportId: 1, entityType: 'unknown', entityId: null, authorId: 3 }).map(
        (l) => l.label
      )
    ).toEqual(['Author in User Lookup']);
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
