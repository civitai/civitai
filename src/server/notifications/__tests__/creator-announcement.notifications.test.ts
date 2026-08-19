import { describe, it, expect } from 'vitest';
import { creatorAnnouncementNotifications } from '../creator-announcement.notifications';

// This notification is a SQL string, so the properties worth pinning are the ones whose
// absence is silent: a missing mute anti-join still sends (to people who muted), and a
// missing profileOnly exclusion still sends (for rows that must notify nobody). Neither
// failure shows up as an error anywhere — the notification just goes to the wrong people.

const processor = creatorAnnouncementNotifications['creator-announcement'];
const LAST_SENT = '2026-08-19T00:00:00.000Z';

function query() {
  const prepared = processor.prepareQuery?.({ lastSent: LAST_SENT } as never);
  if (typeof prepared !== 'string') throw new Error('expected a SQL string');
  return prepared.replace(/\s+/g, ' ');
}

describe('creator announcement fan-out', () => {
  it('resolves the audience from followers at send time', () => {
    const sql = query();

    expect(sql).toContain('"UserEngagement"');
    expect(sql).toMatch(/ue\."targetUserId" = la\.author_id AND ue\.type = 'Follow'/);
    // Rows, not a query, is the shape this deliberately avoids: the allowlist caps at
    // 50,000 and the largest eligible creator has more followers than that.
    expect(sql).not.toContain('AnnouncementUser');
  });

  it('anti-joins the per-creator mute', () => {
    const sql = query();

    expect(sql).toContain('"UserAnnouncementMute"');
    expect(sql).toMatch(
      /NOT EXISTS \( SELECT 1 FROM "UserAnnouncementMute" m WHERE m\."userId" = ue\."userId" AND m\."creatorId" = la\.author_id \)/
    );
  });

  it('honours the category-wide off switch', () => {
    // Whitespace is normalised before matching, but the repo's notification-settings
    // polarity guard scans the raw SQL and only recognises the single-line spelling of
    // this clause — so the shape here has to stay the shape that guard can see.
    expect(query()).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "UserNotificationSettings" uns WHERE uns\."userId" = r\.recipient_id AND uns\.type = 'creator-announcement'\)/
    );
  });

  it('never sends for a platform row or a profile-only row', () => {
    const sql = query();

    expect(sql).toContain('a."userId" IS NOT NULL');
    expect(sql).toContain('a."profileOnly" = false');
    expect(sql).toContain('a.disabled = false');
  });

  it('bounds the scan so a stale cursor cannot walk every announcement ever written', () => {
    expect(query()).toContain("now() - INTERVAL '30 minutes'");
  });

  it('keys one notification per announcement per recipient', () => {
    expect(query()).toContain("concat('creator-announcement:', details->>'announcementId')");
  });

  it('reads as an announcement, naming the creator and the subject', () => {
    const { message, url } = processor.prepareMessage({
      details: { username: 'mnemic', title: 'New LoRA is up', announcementId: 12, creatorId: 5 },
    } as never);

    expect(message).toBe('mnemic made an announcement: New LoRA is up. Check it out.');
    expect(url).toContain('/user/mnemic');
    expect(url).toContain('announcement=12');
  });
});

describe('blocks are honoured, as in every other follow-derived fan-out', () => {
  it('ties each direction to its own type list, not merely to being present', () => {
    const sql = query();

    // 🔴 The asymmetry IS the semantics. Swapping the two arguments to notBlockedBetween
    // leaves both direction pairs present and 'Block','Hide' still somewhere in the
    // string, so assertions that check only for presence pass for the inverted clause.
    // Each direction is pinned to its own type list here.
    //
    // The recipient blocking OR hiding the creator stops it.
    expect(sql).toMatch(
      /blk\."userId" = ue\."userId" AND blk\."targetUserId" = la\.author_id AND blk\.type IN \('Block', 'Hide'\)/
    );
    // The creator's side stops it only on a Block — hiding a follower is not a request to
    // stop being announced to.
    expect(sql).toMatch(
      /blk\."userId" = la\.author_id AND blk\."targetUserId" = ue\."userId" AND blk\.type = 'Block'/
    );
  });
});
