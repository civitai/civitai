import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { ActionType } from '~/server/clickhouse/tracker';
import { trackActionSchema } from '~/server/schema/track.schema';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/**
 * `actions.type` is an Enum16 in ClickHouse. Emitting a value the column does not carry
 * fails at the tracker service, which the app POSTs to fire-and-forget — so the browser
 * sees a successful beacon, nothing is logged here, and the row never exists. The event
 * looks instrumented and produces zero rows.
 *
 * Nothing else in the repo can catch that: typecheck is happy, the emitting component's
 * tests are happy, and the query that comes up empty does so weeks later. This is the
 * only place a new action type is forced to arrive with the DDL that lets it land.
 */
describe('actions.type enum drift', () => {
  // 🔴 `--` comment lines are stripped first. These migrations carry the value in prose
  // as well as in the DDL — a rationale, a verification snippet — so scanning the raw
  // file stays green on a migration whose ALTER was deleted and whose comments were not.
  // Measured: removing the `'Feed_TagBar_Click' = 22` arm left this guard passing.
  const migrationSql = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'))
    .join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  // 🔴 The enum is PARSED, not substring-matched. `toContain("'Feed_TagBar_Click'")` is a
  // far weaker property than "a migration widens actions.type with this value", and four
  // destructive edits were measured passing under it: renumbering the new value onto an
  // index already in use, retargeting the ALTER at a different table, dropping a
  // pre-existing value from the restated list, and gutting the ALTER while leaving the
  // name in a `SELECT`.
  //
  // The dropped-value case is the one to understand: `MODIFY COLUMN Enum16(...)` REPLACES
  // the whole definition, so any name missing from the restated list is removed from a
  // live column. Nothing else in the repo asserts that list is complete.
  const enumBlocks = [
    ...migrationSql.matchAll(
      /ALTER\s+TABLE\s+([\w.]+)\s+MODIFY\s+COLUMN\s+`?type`?\s+Enum16\s*\(([^)]*)\)/gi
    ),
  ].map((m) => ({
    table: m[1].toLowerCase(),
    arms: new Map<string, number>(
      [...m[2].matchAll(/'([A-Za-z0-9_]+)'\s*=\s*(\d+)/g)].map((a) => [a[1], Number(a[2])])
    ),
  }));

  // 🔴 The LAST block, not the first. `MODIFY COLUMN` replaces the definition, so once a
  // second migration restates the column the newest file is the live one — reading the
  // oldest checks a definition prod no longer has, and every value added after it reads as
  // missing. Files are read in name order and these migrations are date-prefixed, so last
  // is newest.
  const actionsBlocks = enumBlocks.filter((b) => b.table === 'default.actions');
  const actionsBlock = actionsBlocks[actionsBlocks.length - 1];

  // The prod indices this guard was written against (SHOW CREATE TABLE actions,
  // 2026-08-21). These predate the migrations directory, so no file here introduces them
  // — but any migration that RESTATES the column must reproduce them exactly, because a
  // MODIFY COLUMN is a replacement.
  //
  // 🔴 Do not add a name here to silence a failing case. That is the one-line bypass of
  // this whole guard, and it produces exactly the "looks instrumented, writes no rows"
  // outcome the file exists to stop. A new type belongs in a migration.
  const PRE_EXISTING: ReadonlyMap<string, number> = new Map([
    ['AddToBounty_Click', 1],
    ['AddToBounty_Confirm', 2],
    ['AwardBounty_Click', 3],
    ['AwardBounty_Confirm', 4],
    ['Tip_Click', 5],
    ['Tip_Confirm', 6],
    ['TipInteractive_Click', 7],
    ['TipInteractive_Cancel', 8],
    ['NotEnoughFunds', 9],
    ['PurchaseFunds_Cancel', 10],
    ['PurchaseFunds_Confirm', 11],
    ['LoginRedirect', 12],
    ['Membership_Cancel', 13],
    ['CSAM_Help_Triggered', 14],
    ['Membership_Downgrade', 15],
    ['ProfanitySearch', 16],
    ['BuzzLimit_Set', 17],
    ['Model_Create_Click', 18],
    ['Image_Remix_Click', 19],
    ['Generator_Submit', 20],
    ['Generator_JobLinked', 21],
    // 🔴 22-25 ADDED 2026-09-05, AND THIS IS A WIDENING OF THE GUARD, NOT AN EXEMPTION —
    // read the warning above before assuming otherwise. Every name below is already
    // carried by an APPLIED migration at exactly this index (`Feed_TagBar_Click` by
    // 2026-08-21-feed-tag-bar-action.sql, the three announcement values by
    // 2026-09-04-announcement-click-action.sql). Listing them here makes the
    // "restates every pre-existing value at the index it already has" case cover them;
    // it does NOT exempt anything from needing a migration, because the `it.each` below
    // is driven by `ActionType` and skips only names present in this map — and each of
    // these four is in a migration already.
    //
    // WHY IT MATTERED: before this, values past 21 were checked for NAME PRESENCE only.
    // Measured — editing a migration to `'Announcement_Unmute' = 30` passed 10/10, i.e.
    // the one destructive class the migrations' own headers forbid ("Do NOT renumber…
    // that WOULD rewrite the whole table") was unguarded, and every value added after
    // the baseline enlarged the blind set. Positive control from the same measurement:
    // dropping `'ProfanitySearch' = 16` correctly reds, so the mechanism itself works.
    ['Feed_TagBar_Click', 22],
    ['Announcement_Click', 23],
    ['Announcement_Mute', 24],
    ['Announcement_Unmute', 25],
  ]);

  it('freezes the pre-existing baseline', () => {
    // Growing this map is how a new type gets exempted without a migration, so the size
    // is pinned. If prod legitimately gains a value outside these migrations, update it
    // deliberately and say why.
    //
    // 21 -> 25 on 2026-09-05: the four values above were moved from "name checked, index
    // unchecked" into the index-pinned set. The number is a tripwire on THIS list, so it
    // moves with it; what must never happen is a name being added here INSTEAD of to a
    // migration.
    expect(PRE_EXISTING.size).toBe(25);
  });

  it('found an ALTER on default.actions to scan', () => {
    // Scoped to THIS table, not to "some ALTER TABLE somewhere". The directory holds
    // other migrations, so a `/ALTER TABLE/` control passes even when the actions
    // migration has been reduced to a bare SELECT — measured.
    expect(
      actionsBlock,
      'no MODIFY COLUMN on default.actions found in any migration'
    ).toBeDefined();
    expect(actionsBlock.arms.size).toBeGreaterThan(0);
  });

  it.each([...ActionType].filter((t) => !PRE_EXISTING.has(t)))(
    '%s is widened into the actions enum by a migration',
    (type) => {
      expect([...actionsBlock.arms.keys()]).toContain(type);
    }
  );

  it('restates every pre-existing value at the index it already has', () => {
    // A MODIFY COLUMN replaces the definition: a name left out is dropped from a live
    // column, and a name given a different index silently remaps existing rows. The
    // migration's own header forbids both; this is what makes that enforceable.
    for (const [name, index] of PRE_EXISTING) {
      expect(actionsBlock.arms.get(name), `${name} missing from the restated enum`).toBe(index);
    }
  });

  it('assigns every value a distinct index', () => {
    const indices = [...actionsBlock.arms.values()];
    expect(new Set(indices).size).toBe(indices.length);
  });

  // Every type the client is allowed to SEND must be one the Tracker can WRITE. The
  // reverse does not hold — `BuzzLimit_Set` is emitted server-side and has no client
  // schema arm — so this is containment, not equality.
  it('every trackActionSchema arm is an ActionType', () => {
    const schemaTypes = trackActionSchema.options.map(
      (option) => option.shape.type.value as string
    );

    expect(schemaTypes.length).toBeGreaterThan(0);
    expect(schemaTypes).toContain('Feed_TagBar_Click');
    expect(
      schemaTypes.filter((t) => !ActionType.includes(t as (typeof ActionType)[number]))
    ).toEqual([]);
  });
});
