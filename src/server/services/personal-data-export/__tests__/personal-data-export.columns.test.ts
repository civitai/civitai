import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_COLUMNS,
  CLASSIFIER_NAME_RE,
  CREDENTIAL_COLUMNS,
  CREDENTIAL_NAME_RE,
  DETECTION_TEXT_RE,
  JSON_ALLOWED,
  NOTE_COLUMNS,
  OTHER_PEOPLE_COLUMNS,
  STAFF_NAME_RE,
  STAFF_PLACEHOLDER,
  columnDecision,
  redactNoteText,
  scrubJson,
} from '../column-policy';
import { planPostgresExport, selectSql, transformRow } from '../sources/postgres';

const SUBJECT = 4242;
const OTHER = 999;
const plans = planPostgresExport(SUBJECT);
const planFor = (name: string) => {
  const plan = plans.find((p) => p.name === name);
  if (!plan) throw new Error(`no plan ${name}`);
  return plan;
};
const selected = (name: string) => planFor(name).columns.map((c) => c.field);

describe('personal-data-export column policy, over every planned read', () => {
  it('selects no credential-, classifier- or other-people column on any table', () => {
    const leaks: string[] = [];
    for (const plan of plans)
      for (const c of [...plan.columns, ...plan.noteColumns]) {
        if (CREDENTIAL_NAME_RE.test(c.field) || CLASSIFIER_NAME_RE.test(c.field))
          leaks.push(`${plan.name}.${c.field}`);
        for (const list of [CREDENTIAL_COLUMNS, CLASSIFIER_COLUMNS, OTHER_PEOPLE_COLUMNS])
          if (list[plan.model]?.includes(c.field)) leaks.push(`${plan.name}.${c.field}`);
      }
    expect(leaks).toEqual([]);
    // The listed columns exist, so their absence above means something.
    for (const [table, cols] of Object.entries({ ...CREDENTIAL_COLUMNS, ...OTHER_PEOPLE_COLUMNS }))
      if (plans.some((p) => p.model === table))
        expect(selectSql(planFor(table)), table).not.toMatch(new RegExp(`"(${cols.join('|')})"`));
    expect(selected('Account')).toEqual(expect.arrayContaining(['provider', 'providerAccountId']));
    expect(selected('Session')).toContain('expires');
  });

  /**
   * Named literally, not through the policy's own lists and patterns: a check that judges the plan
   * with the same rules that made it moves with them, and stays green when one is weakened.
   */
  it('never selects these credential columns, by name', () => {
    const NEVER = {
      Session: ['sessionToken'],
      Account: ['access_token', 'refresh_token', 'id_token'],
      ApiKey: ['key'],
      AccessToken: ['tokenHash'],
      VerificationToken: ['token'],
      Partner: ['token'],
      OauthClient: ['secret'],
    };
    // These are exported, so their columns are really planned and the absence below means something.
    for (const table of ['Session', 'Account', 'ApiKey', 'AccessToken'])
      expect(
        plans.some((p) => p.model === table),
        table
      ).toBe(true);
    for (const [table, cols] of Object.entries(NEVER))
      for (const plan of plans.filter((p) => p.model === table)) {
        const columnList = selectSql(plan).split(' FROM ')[0];
        for (const col of cols) {
          expect(selected(plan.name), `${plan.name}.${col}`).not.toContain(col);
          expect(columnList, `${plan.name}.${col}`).not.toContain(`"${col}"`);
        }
      }
    // No table has these today, so only their names can be checked: a future one is withheld.
    for (const col of ['password', 'passwordHash', 'sessionToken', 'apiKey', 'clientSecret'])
      expect(columnDecision('NewTable', col, 'String'), col).toBe('credential');
    // User has no credential column today; any that appears is not selected.
    expect(
      plans
        .filter((p) => p.model === 'User')
        .flatMap((p) => p.columns.map((c) => c.field))
        .filter((f) => /pass|secret|token|hash|salt/i.test(f))
    ).toEqual([]);
  });

  it("doesn't tell an author their text is held or was refused", () => {
    const text = plans.find((p) => p.model === 'PostText');
    expect(text).toBeDefined();
    const columnList = selectSql(text!).split(' FROM ')[0];
    expect(columnList).toContain('"content"');
    for (const col of ['csamHeld', 'refused']) expect(columnList).not.toContain(`"${col}"`);
  });

  it('writes no text column an automated check fills, on any table', () => {
    const leaks = plans.flatMap((p) =>
      p.columns
        .filter((c) => c.type === 'String' && DETECTION_TEXT_RE.test(c.field))
        .map((c) => `${p.name}.${c.field}`)
    );
    expect(leaks).toEqual([]);
    expect(selected('ModelFile')).not.toContain('virusScanMessage');
    expect(selected('WildcardSet')).not.toContain('auditRuleVersion');
  });

  it('withholds a future text column an automated check fills, by its name alone', () => {
    expect(columnDecision('NewTable', 'malwareScanMessage', 'String')).toBe('classifier');
    expect(columnDecision('NewTable', 'auditNote', 'String')).toBe('classifier');
    // Control: an ordinary text column of an unknown table is read.
    expect(columnDecision('NewTable', 'title', 'String')).toBe('read');
  });

  it('withholds every JSON column that is not allow-listed (User.meta and Model.meta among them)', () => {
    const json = plans.flatMap((p) =>
      p.columns.filter((c) => c.type === 'Json').map((c) => `${p.model}.${c.field}`)
    );
    const allowed = Object.entries(JSON_ALLOWED).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`));
    expect(json.filter((c) => !allowed.includes(c))).toEqual([]);
    expect(selected('User')).not.toContain('meta');
    expect(selected('Model')).not.toContain('meta');
    expect(selected('Image')).toContain('meta'); // control: an allowed one is still read
  });

  it('never writes staff-written text into a data file, and hands it to the notes file', () => {
    for (const [table, cols] of Object.entries(NOTE_COLUMNS)) {
      if (!plans.some((p) => p.model === table)) continue;
      const plan = plans.find((p) => p.model === table)!;
      for (const col of cols) {
        expect(
          plan.columns.map((c) => c.field),
          `${table}.${col}`
        ).not.toContain(col);
        expect(
          plan.noteColumns.map((c) => c.field),
          `${table}.${col}`
        ).toContain(col);
        const { out, notes } = transformRow(plan, { id: 1, [col]: 'by mod bob' }, SUBJECT);
        expect(out).not.toHaveProperty(col);
        expect(notes).toEqual([{ column: col, text: 'by mod bob' }]);
      }
    }
    expect(planFor('Appeal').noteColumns.map((c) => c.field)).toContain('internalNotes');
  });

  it('writes every staff-id column as [staff] unless it is the user, on every table', () => {
    const missed: string[] = [];
    let checked = 0;
    for (const plan of plans)
      for (const c of plan.columns) {
        const staff =
          c.role === 'staff' ||
          (c.role === null && c.type === 'Int' && STAFF_NAME_RE.test(c.field));
        if (!staff) continue;
        checked++;
        if (transformRow(plan, { [c.field]: OTHER }, SUBJECT).out[c.field] !== STAFF_PLACEHOLDER)
          missed.push(`${plan.name}.${c.field}`);
        if (transformRow(plan, { [c.field]: SUBJECT }, SUBJECT).out[c.field] !== SUBJECT)
          missed.push(`${plan.name}.${c.field} (own id)`);
      }
    expect(missed).toEqual([]);
    expect(checked).toBeGreaterThan(30);
    // Named by the reviews: plain-int staff columns with no relation to User.
    for (const [table, col] of [
      ['UserRole', 'addedById'],
      ['CreatorScoreGrant', 'revokedById'],
      ['Placement', 'takenDownById'],
      ['Crucible', 'takenDownById'],
      ['UserRestriction', 'resolvedBy'],
    ])
      expect(
        transformRow(planFor(table), { [col]: OTHER }, SUBJECT).out[col],
        `${table}.${col}`
      ).toBe(STAFF_PLACEHOLDER);
    // Another user's id is not staff: a received message keeps its sender's id.
    expect(transformRow(planFor('ChatMessage.received'), { userId: 555 }, SUBJECT).out.userId).toBe(
      555
    );
  });
});

describe('personal-data-export row rules', () => {
  it('writes a removed image as "removed" instead of its URL', () => {
    const image = planFor('Image');
    const base = { id: 1, url: 'abc', ingestion: 'Scanned', tosViolation: false, blockedFor: null };
    expect(transformRow(image, base, SUBJECT).out.url).toBe('abc');
    expect(transformRow(image, { ...base, ingestion: 'Blocked' }, SUBJECT).out.url).toBe('removed');
    expect(transformRow(image, { ...base, tosViolation: true }, SUBJECT).out.url).toBe('removed');
    expect(transformRow(image, { ...base, blockedFor: 'tos' }, SUBJECT).out.url).toBe('removed');
    // The block reason decides it, but its text (which an automated check can write) never goes out.
    const blocked = transformRow(image, { ...base, blockedFor: 'audit: matched xyz' }, SUBJECT).out;
    expect(blocked.url).toBe('removed');
    expect(blocked).not.toHaveProperty('blockedFor');
    expect(selected('Image')).not.toContain('blockedFor');
    // Still SELECTed (the rule needs it): look in the column list, not the WHERE, which names it too.
    expect(selectSql(image).split(' FROM ')[0]).toContain('"blockedFor"');
  });

  it("drops detection keys inside an allowed JSON column and keeps the user's own", () => {
    const meta = { prompt: 'a cat', seed: 1, nested: { score: 0.9, threshold: 0.5, steps: 20 } };
    const out = transformRow(planFor('Image'), { meta }, SUBJECT).out.meta;
    expect(out).toEqual({ prompt: 'a cat', seed: 1, nested: { steps: 20 } });
    expect(scrubJson([{ labels: ['x'], cfgScale: 7 }])).toEqual([{ cfgScale: 7 }]);
    // The user's own record of what they used stays.
    const kept = { hashes: { model: 'abc' }, checkpoint: 'x', point: 1, 'Model hash': 'h' };
    expect(scrubJson(kept)).toEqual(kept);
  });

  it("reduces a restriction's triggers to category, the user's prompt and time", () => {
    const triggers = [
      { category: 'prompt', prompt: 'my prompt', time: '2026-01-01', score: 0.97, rule: 'r1' },
    ];
    expect(transformRow(planFor('UserRestriction'), { triggers }, SUBJECT).out.triggers).toEqual([
      { category: 'prompt', prompt: 'my prompt', time: '2026-01-01' },
    ]);
  });

  it("shows a staff removal of a placement as staff, and keeps the owner's own decision", () => {
    const placement = planFor('Placement');
    const row = { id: 1, ownerId: 7, placerId: SUBJECT, status: 'removed', removedBy: 'moderator' };
    for (const removedBy of ['moderator', 'cosmeticTakedown'])
      expect(
        transformRow(placement, { ...row, removedBy, resolvedById: 900 }, SUBJECT).out.resolvedById
      ).toBe('[staff]');
    // Even a staff removal by the owner's own account says staff, not the id.
    expect(transformRow(placement, { ...row, resolvedById: 7 }, SUBJECT).out.resolvedById).toBe(
      '[staff]'
    );
    // Anyone but the owner, whatever the row says.
    expect(
      transformRow(placement, { ...row, removedBy: null, resolvedById: 900 }, SUBJECT).out
        .resolvedById
    ).toBe('[staff]');
    // The owner approving or declining: kept (control).
    for (const status of ['approved', 'declined'])
      expect(
        transformRow(placement, { ...row, status, removedBy: null, resolvedById: 7 }, SUBJECT).out
          .resolvedById
      ).toBe(7);
    expect(
      transformRow(placement, { ...row, removedBy: null, resolvedById: null }, SUBJECT).out
        .resolvedById
    ).toBeNull();
  });

  it('does not name the gifter of an anonymous gift to its recipient', () => {
    const gift = planFor('MembershipGift');
    const row = {
      id: 'g',
      gifterId: 7,
      recipientId: SUBJECT,
      anonymous: true,
      stripePaymentIntentId: 'pi_1',
      amountCents: 999,
    };
    expect(transformRow(gift, row, SUBJECT).out).toMatchObject({
      gifterId: null,
      stripePaymentIntentId: null,
      amountCents: null,
    });
    expect(transformRow(gift, { ...row, anonymous: false }, SUBJECT).out.gifterId).toBe(7);
    expect(transformRow(gift, { ...row, gifterId: SUBJECT }, SUBJECT).out.gifterId).toBe(SUBJECT);
  });

  it('gives reports about the user their reason, date and outcome only', () => {
    expect(selected('Report.aboutYou').sort()).toEqual(
      ['createdAt', 'id', 'reason', 'status', 'statusSetAt'].sort()
    );
  });

  it('refuses an id that is not a positive integer, since the id is inlined in the SQL', () => {
    expect(() => planPostgresExport(0)).toThrow();
    expect(() => planPostgresExport(1.5)).toThrow();
    expect(() => planPostgresExport(Number.NaN)).toThrow();
  });
});

describe('redactNoteText', () => {
  const staff = { usernames: ['ModAlice', 'bob'], ids: [12345] };
  it('replaces moderator names and ids, and leaves other text alone', () => {
    expect(redactNoteText('Reviewed by @ModAlice, see user 12345 and order 999', staff)).toBe(
      `Reviewed by ${STAFF_PLACEHOLDER}, see user ${STAFF_PLACEHOLDER} and order 999`
    );
    expect(redactNoteText('bob said ok; bobby did not', staff)).toBe(
      `${STAFF_PLACEHOLDER} said ok; bobby did not`
    );
  });
});
