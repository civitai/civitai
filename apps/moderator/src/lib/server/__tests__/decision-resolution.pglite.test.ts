import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentResolutions,
  partitionResolutions,
  recordResolution,
  resolutionAnswer,
  type NewResolution,
} from '../decision-resolution.service';
import {
  decisionsKysely,
  freshDecisionsDb,
  insertRaw,
  v1DecisionsDb,
} from './decision-resolution-pglite.harness';

/**
 * The resolution writer and reader, run UNMODIFIED against the real DDL. Append-only and "latest per
 * item wins" are claims about which rows exist, so only rows can answer them.
 */

let open: PGlite[] = [];
const setup = async (make: () => Promise<PGlite> = freshDecisionsDb) => {
  const pg = await make();
  open.push(pg);
  return { pg, k: decisionsKysely(pg) };
};
afterEach(async () => {
  for (const d of open) await d.close();
  open = [];
});

const GK = 'g_3fa9c01d22be';
const ruling = (over: Partial<NewResolution> = {}): NewResolution => ({
  source: 'support-ticket',
  itemKey: GK,
  subKey: '',
  sourceVersion: 'v-test',
  area: 'billing-buzz',
  ruling: 'correct',
  targetKey: null,
  escalateTo: null,
  note: null,
  ruledBy: 4821,
  shown: { n_members: 3, members: [{ ticket_id: '1', p_group: null, p_novel: null }] },
  ...over,
});

const allRows = async (pg: PGlite) =>
  (
    await pg.query<{ ruling: string; apply_state: string; shown: unknown; ruled_by: number }>(
      'SELECT ruling, apply_state, shown, ruled_by FROM decision_resolution ORDER BY id'
    )
  ).rows;

describe('recordResolution', () => {
  it('appends — a re-ruling is a second row, never an overwrite', async () => {
    const { pg, k } = await setup();
    expect((await recordResolution(ruling({ ruling: 'correct' }), k)).inserted).toBe(1);
    expect((await recordResolution(ruling({ ruling: 'split' }), k)).inserted).toBe(1);
    expect((await allRows(pg)).map((r) => r.ruling)).toEqual(['correct', 'split']);
  });

  it('stores the `shown` snapshot verbatim — nulls stay null, never 0', async () => {
    const { pg, k } = await setup();
    const shown = { n_members: 3, members: [{ ticket_id: '1', p_group: null, p_novel: 0.22 }] };
    await recordResolution(ruling({ shown }), k);
    expect((await allRows(pg))[0].shown).toEqual(shown);
  });

  it('stores every field it was given — read back whole', async () => {
    const { pg, k } = await setup();
    await recordResolution(
      ruling({
        ruling: 'duplicate_of',
        targetKey: 'g_000000000001',
        note: 'same refund issue',
        area: 'payment-refund',
        sourceVersion: 'v-9',
        ruledBy: 31,
      }),
      k
    );
    const row = (
      await pg.query(
        `SELECT source, item_key, sub_key, source_version, area, ruling, target_key, escalate_to,
                note, ruled_by, apply_state FROM decision_resolution`
      )
    ).rows[0];
    expect(row).toEqual({
      source: 'support-ticket',
      item_key: GK,
      sub_key: '',
      source_version: 'v-9',
      area: 'payment-refund',
      ruling: 'duplicate_of',
      target_key: 'g_000000000001',
      escalate_to: null,
      note: 'same refund issue',
      ruled_by: 31,
      apply_state: 'pending',
    });
  });

  it('records the moderator id', async () => {
    const { pg, k } = await setup();
    await recordResolution(ruling({ ruledBy: 77 }), k);
    expect((await allRows(pg))[0].ruled_by).toBe(77);
  });

  it("writes duplicate_of and park as apply_state 'pending', everything else 'n/a'", async () => {
    const { pg, k } = await setup();
    await recordResolution(ruling({ ruling: 'duplicate_of', targetKey: 'g_000000000001' }), k);
    await recordResolution(ruling({ ruling: 'park' }), k);
    await recordResolution(ruling({ ruling: 'escalate', escalateTo: 'billing-buzz' }), k);
    await recordResolution(ruling({ ruling: 'belongs', subKey: '10001' }), k);
    expect((await allRows(pg)).map((r) => [r.ruling, r.apply_state])).toEqual([
      ['duplicate_of', 'pending'],
      ['park', 'pending'],
      ['escalate', 'n/a'],
      ['belongs', 'n/a'],
    ]);
  });

  it('refuses duplicate_of without a target (the DDL, not just the form)', async () => {
    const { k } = await setup();
    await expect(
      recordResolution(ruling({ ruling: 'duplicate_of', targetKey: null }), k)
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses a target on anything but duplicate_of, and a member label without a ticket', async () => {
    const { pg } = await setup();
    await expect(insertRaw(pg, { ruling: 'correct', target_key: 'g_x' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRaw(pg, { ruling: 'belongs', sub_key: '' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRaw(pg, { ruling: 'correct', sub_key: '10001' })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it("refuses a pending ruling born 'n/a' and a label born 'pending'", async () => {
    const { pg } = await setup();
    await expect(insertRaw(pg, { ruling: 'park', apply_state: 'n/a' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insertRaw(pg, { ruling: 'correct', apply_state: 'pending' })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an unknown ruling through the CHECK', async () => {
    const { pg } = await setup();
    await expect(insertRaw(pg, { ruling: 'merge' })).rejects.toMatchObject({ code: '23514' });
  });

  it('names schema.sql when the table does not exist', async () => {
    const { pg, k } = await setup();
    await pg.exec('DROP TABLE decision_resolution');
    await expect(recordResolution(ruling(), k)).rejects.toThrow(/decisions\/schema\.sql/);
  });
});

describe('currentResolutions — the latest ruling per item wins', () => {
  it('returns one row per (item, sub_key): the latest', async () => {
    const { k } = await setup();
    await recordResolution(ruling({ ruling: 'correct' }), k);
    await recordResolution(ruling({ ruling: 'escalate', escalateTo: 'crypto' }), k);
    await recordResolution(ruling({ ruling: 'belongs', subKey: '1' }), k);
    await recordResolution(ruling({ ruling: 'not_belongs', subKey: '1' }), k);
    await recordResolution(ruling({ ruling: 'unsure', subKey: '2' }), k);

    const out = await currentResolutions(
      { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: [GK] },
      k
    );
    expect(out.map((r) => [r.subKey, r.ruling]).sort()).toEqual([
      ['', 'escalate'],
      ['1', 'not_belongs'],
      ['2', 'unsure'],
    ]);
  });

  it('breaks a same-instant tie by id — two rulings in one transaction share now()', async () => {
    const { pg, k } = await setup();
    await pg.exec('BEGIN');
    await insertRaw(pg, { ruling: 'correct' });
    await insertRaw(pg, { ruling: 'skip' });
    await pg.exec('COMMIT');
    const out = await currentResolutions(
      { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: ['g_aaaaaaaaaaaa'] },
      k
    );
    expect(out.map((r) => r.ruling)).toEqual(['skip']);
  });

  it('is scoped to the version and to the items asked for', async () => {
    const { k } = await setup();
    await recordResolution(ruling({ ruling: 'correct' }), k);
    await recordResolution(ruling({ ruling: 'split', sourceVersion: 'v-other' }), k);
    await recordResolution(ruling({ ruling: 'park', itemKey: 'g_other0000000' }), k);
    const out = await currentResolutions(
      { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: [GK] },
      k
    );
    expect(out.map((r) => r.ruling)).toEqual(['correct']);
  });

  it('asks nothing for an empty item list', async () => {
    const { k } = await setup();
    expect(
      await currentResolutions({ source: 'support-ticket', sourceVersion: 'v', itemKeys: [] }, k)
    ).toEqual([]);
  });
});

const ANSWER = 'Clear site data for the domain, then sign in again.';

describe('the resolved ruling', () => {
  it('stores the answer and its source, and reads them back by the group ruling id', async () => {
    const { pg, k } = await setup();
    await recordResolution(
      ruling({
        ruling: 'resolved',
        answer: { text: ANSWER, source: { ticketId: '73618', conversationId: '150003911207' } },
      }),
      k
    );
    const { groups } = partitionResolutions(
      await currentResolutions(
        { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: [GK] },
        k
      )
    );
    const g = groups.get(GK);
    expect(g?.ruling).toBe('resolved');
    expect(await resolutionAnswer(g!.id, k)).toEqual({
      text: ANSWER,
      source: { ticketId: '73618', conversationId: '150003911207' },
    });
    expect((await allRows(pg))[0].apply_state).toBe('n/a');
  });

  it('un-resolving is a newer ruling — the answer row stays, and the current ruling has none', async () => {
    const { pg, k } = await setup();
    await recordResolution(
      ruling({ ruling: 'resolved', answer: { text: ANSWER, source: null } }),
      k
    );
    await recordResolution(ruling({ ruling: 'correct' }), k);
    const current = await currentResolutions(
      { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: [GK] },
      k
    );
    expect(current.map((r) => r.ruling)).toEqual(['correct']);
    expect(await resolutionAnswer(current[0].id, k)).toBeNull();
    expect((await allRows(pg)).map((r) => r.ruling)).toEqual(['resolved', 'correct']);
  });

  it('refuses resolved without an answer, and an answer on another ruling (the DDL)', async () => {
    const { k } = await setup();
    await expect(recordResolution(ruling({ ruling: 'resolved' }), k)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      recordResolution(ruling({ ruling: 'split', answer: { text: ANSWER, source: null } }), k)
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/**
 * 🔴 THE DEPLOY-ORDER GAP. The app can be released before the DDL reaches a database. Every ruling
 * other than `resolved` must keep working there, and `resolved` must fail naming the file to apply.
 */
describe('on a database the resolved DDL has not reached (v1)', () => {
  it('still records and reads every other ruling', async () => {
    const { k } = await setup(v1DecisionsDb);
    expect((await recordResolution(ruling({ ruling: 'park' }), k)).inserted).toBe(1);
    expect(
      (await recordResolution(ruling({ ruling: 'belongs', subKey: '20417' }), k)).inserted
    ).toBe(1);
    const out = await currentResolutions(
      { source: 'support-ticket', sourceVersion: 'v-test', itemKeys: [GK] },
      k
    );
    expect(out.map((r) => r.ruling).sort()).toEqual(['belongs', 'park']);
  });

  it('refuses resolved with a message naming schema.sql', async () => {
    const { k } = await setup(v1DecisionsDb);
    await expect(
      recordResolution(ruling({ ruling: 'resolved', answer: { text: ANSWER, source: null } }), k)
    ).rejects.toThrow(
      /predates the `resolved` ruling — apply apps\/moderator\/decisions\/schema\.sql/
    );
  });
});
