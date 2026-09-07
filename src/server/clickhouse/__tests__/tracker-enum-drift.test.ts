import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { ReactionType, ReportType } from '~/server/clickhouse/tracker';
import { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus, ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * Enum drift on every tracker-written column EXCEPT `actions.type`.
 *
 * `actions.type` has had a guard since 2026-08-21 (./action-type-enum-drift.test.ts).
 * Nothing else did — and that narrowness is the entire reason this file exists. A sweep of
 * tracker rejections over a 2h38m window on 2026-09-07 found three live gaps, none of them
 * on `actions`:
 *
 *   * `reactions.nsfw` lacked 'Blocked' — 7 of 10 rejections in that window, all real
 *     users, on the order of ~387 rows/day silently discarded.
 *   * `reports.reason` lacked 'Spam' and 'StickerPlacement'.
 *   * `reactions.type` lacks 'Post_Create' and 'Post_Delete'.
 *
 * A fourth, `reports.entityType`, was found by writing this guard.
 *
 * 🔴 WHY NOTHING ELSE CATCHES IT. The rejection is CLIENT-SIDE, inside the tracker service,
 * while it serializes the batch — the app POSTs fire-and-forget, so the caller sees success,
 * nothing is logged here, and the row never exists. `SHOW CREATE TABLE` is clean because the
 * DDL genuinely is. Typecheck was clean too: the reaction controller built its `type` with a
 * template literal (inferred `string`) and laundered it through `as ReactionType` at the call
 * site, so the one branch emitting a value the column has never carried type-checked for as
 * long as it has existed. That cast is gone; this file is what stops the class coming back.
 *
 * THE PROPERTY: for every enum column the tracker writes, every value the APP can emit must
 * be present in the column's effective definition — the newest migration that states it, or,
 * for a column no migration has touched, the measured production baseline below.
 *
 * Containment, not equality: a column is allowed to be WIDER than the app domain
 * (`reactions.nsfw` carries 'Undefined', which no app value maps to). Narrower is the defect.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

const sqlFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, raw: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8') }));

/**
 * 🔴 Comments are stripped BEFORE anything is parsed. These migrations carry their values in
 * prose as well as in DDL — a rationale, a verification snippet, a POST-APPLY block — so a
 * parser fed the raw file stays green on a migration whose ALTER was deleted and whose
 * comments were not. Measured on the sibling guard: removing an arm left it passing.
 */
const stripComments = (raw: string) =>
  raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

/**
 * 🔴 MULTI-LINE BY CONSTRUCTION. Every migration in this directory writes the statement as
 * `ALTER TABLE default.reactions\n  MODIFY COLUMN ...`, and the enum arms are one per line.
 * A regex anchored to a single line matches ZERO of them — and a guard built on it scans an
 * empty set and passes on everything, which is the same reassuring zero this file exists to
 * stop. `\s+` spans newlines; `parsedBlockCount` below is the control that proves it did.
 *
 * Enum8 and Enum16 are both accepted: `actions.type` is Enum16, every column here is Enum8,
 * and a guard that silently skipped one width would have exactly the blind spot above.
 */
const ENUM_COLUMN_RE =
  /ALTER\s+TABLE\s+([\w.]+)\s+MODIFY\s+COLUMN\s+`?(\w+)`?\s+Enum(?:8|16)\s*\(([^)]*)\)/gi;

type EnumBlock = {
  file: string;
  column: string; // "<table>.<column>", lower-cased
  arms: Map<string, number>;
  multiLine: boolean;
};

const enumBlocks: EnumBlock[] = sqlFiles.flatMap(({ name, raw }) =>
  [...stripComments(raw).matchAll(ENUM_COLUMN_RE)].map((m) => ({
    file: name,
    column: `${m[1]}.${m[2]}`.toLowerCase(),
    arms: new Map<string, number>(
      [...m[3].matchAll(/'([A-Za-z0-9_]+)'\s*=\s*(\d+)/g)].map((a) => [a[1], Number(a[2])])
    ),
    multiLine: m[0].includes('\n'),
  }))
);

/**
 * The `reactions_owner_scores_mv` +1 list. Parsed, not substring-matched, because the
 * property that matters is set equality against the column's '*_Create' values — see the
 * coupling test at the bottom of this file for why that is not cosmetic.
 */
const MV_QUERY_RE =
  /ALTER\s+TABLE\s+default\.reactions_owner_scores_mv\s+MODIFY\s+QUERY([\s\S]*?);/gi;

const mvBlocks = sqlFiles.flatMap(({ name, raw }) =>
  [...stripComments(raw).matchAll(MV_QUERY_RE)].map((m) => {
    const inList = /type\s+IN\s*\(([^)]*)\)/i.exec(m[1]);
    return {
      file: name,
      plusOne: new Set<string>(
        inList ? [...inList[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((a) => a[1]) : []
      ),
    };
  })
);

/** The newest block wins: `MODIFY COLUMN` replaces the definition, and files are date-named. */
const lastBlockFor = (column: string) => {
  const matching = enumBlocks.filter((b) => b.column === column);
  return matching[matching.length - 1];
};

type ColumnSpec = {
  /** "<table>.<column>", lower-cased — the key the parser produces. */
  column: string;
  /** Where the app-side domain lives, for the failure message. */
  domain: string;
  /** Every value the app can emit into this column. */
  appValues: readonly string[];
  /**
   * The production definition as it stood BEFORE any migration in this directory touched
   * the column, measured with `SHOW CREATE TABLE` on 2026-09-07.
   *
   * 🔴 Do NOT add a name here to silence a failing case. That is the one-line bypass of this
   * whole guard and it reproduces precisely the "looks instrumented, writes no rows" outcome
   * the file exists to stop — the value would be in the app and still absent from the column.
   * A new value belongs in a migration.
   */
  baseline: ReadonlyMap<string, number>;
};

const COLUMNS: readonly ColumnSpec[] = [
  {
    column: 'default.reactions.type',
    domain: 'ReactionType (src/server/clickhouse/tracker.ts)',
    appValues: ReactionType,
    baseline: new Map([
      ['Image_Create', 1],
      ['Image_Delete', 2],
      ['Comment_Create', 3],
      ['Comment_Delete', 4],
      ['CommentV2_Create', 5],
      ['CommentV2_Delete', 6],
      ['Review_Create', 7],
      ['Review_Delete', 8],
      ['Question_Create', 9],
      ['Question_Delete', 10],
      ['Answer_Create', 11],
      ['Answer_Delete', 12],
      ['BountyEntry_Create', 13],
      ['BountyEntry_Delete', 14],
      ['Article_Create', 15],
      ['Article_Delete', 16],
    ]),
  },
  {
    column: 'default.reactions.reaction',
    domain: 'ReviewReactions (Prisma)',
    appValues: Object.values(ReviewReactions),
    baseline: new Map([
      ['Like', 1],
      ['Dislike', 2],
      ['Laugh', 3],
      ['Cry', 4],
      ['Heart', 5],
    ]),
  },
  {
    column: 'default.reactions.nsfw',
    // 'Undefined' = 0 has no app counterpart; the column may be wider than the domain.
    domain: 'NsfwLevelDeprecated (src/shared/constants/browsingLevel.constants.ts)',
    appValues: Object.values(NsfwLevelDeprecated),
    baseline: new Map([
      ['Undefined', 0],
      ['None', 1],
      ['Soft', 2],
      ['Mature', 3],
      ['X', 4],
    ]),
  },
  {
    column: 'default.reports.type',
    domain: 'ReportType (src/server/clickhouse/tracker.ts)',
    appValues: ReportType,
    baseline: new Map([
      ['Create', 1],
      ['StatusChange', 2],
    ]),
  },
  {
    column: 'default.reports.entitytype',
    domain: 'ReportEntity (src/shared/utils/report-helpers.ts)',
    appValues: Object.values(ReportEntity),
    baseline: new Map([
      ['model', 1],
      ['comment', 2],
      ['commentV2', 3],
      ['image', 4],
      ['resourceReview', 5],
      ['article', 6],
      ['post', 7],
      ['reportedUser', 8],
      ['collection', 9],
      ['bounty', 10],
      ['bountyEntry', 11],
      ['chat', 12],
    ]),
  },
  {
    column: 'default.reports.reason',
    domain: 'ReportReason (Prisma)',
    appValues: Object.values(ReportReason),
    baseline: new Map([
      ['TOSViolation', 1],
      ['NSFW', 2],
      ['Ownership', 3],
      ['AdminAttention', 4],
      ['Claim', 5],
      ['CSAM', 6],
      ['Automated', 7],
    ]),
  },
  {
    column: 'default.reports.status',
    domain: 'ReportStatus (Prisma)',
    appValues: Object.values(ReportStatus),
    baseline: new Map([
      ['Pending', 1],
      ['Processing', 2],
      ['Actioned', 3],
      ['Unactioned', 4],
    ]),
  },
];

/** Effective definition: the newest migration that states the column, else the baseline. */
const effectiveArms = (spec: ColumnSpec) => lastBlockFor(spec.column)?.arms ?? spec.baseline;

describe('tracker enum drift (reactions + reports)', () => {
  describe('the parser actually parsed something', () => {
    // 🔴 POSITIVE CONTROLS. Every `it.each` below is driven by parsed data, so a regex that
    // matches nothing turns the whole file into a green that means "scanned zero columns".
    // These are the only assertions here that would notice.
    it('scans the migrations directory', () => {
      expect(sqlFiles.length, 'no .sql migrations found to scan').toBeGreaterThanOrEqual(8);
    });

    it('parses multi-line ALTER ... MODIFY COLUMN statements', () => {
      // Every migration here writes the table and the MODIFY COLUMN on separate lines. If
      // this is 0 the regex has been narrowed to a single line and covers nothing.
      const multiLine = enumBlocks.filter((b) => b.multiLine);
      expect(
        multiLine.length,
        'no multi-line enum ALTER parsed — the statements in this directory are all multi-line, ' +
          'so a zero here means the parser is matching an empty set and every check below is vacuous'
      ).toBeGreaterThanOrEqual(5);
    });

    it('found a migration block for every column this change defines', () => {
      // Named explicitly rather than counted, so a rename or a retargeted ALTER is caught
      // instead of being absorbed by a total that happens to stay the same.
      const defined = [
        'default.reactions.type',
        'default.reactions.nsfw',
        'default.reports.reason',
        'default.reports.entitytype',
      ];
      expect(defined.filter((c) => !lastBlockFor(c))).toEqual([]);
    });

    it('found the reactions_owner_scores_mv MODIFY QUERY', () => {
      expect(mvBlocks.length, 'no ALTER ... MODIFY QUERY on the MV found').toBeGreaterThanOrEqual(
        1
      );
      expect(mvBlocks[mvBlocks.length - 1].plusOne.size).toBeGreaterThan(0);
    });
  });

  it.each(COLUMNS.map((c) => [c.column, c] as const))(
    '%s baseline matches the production definition it was measured from',
    (_column, spec) => {
      // A tripwire on the baseline map itself: growing it is how a value gets exempted from
      // needing a migration. Change it deliberately, with a fresh SHOW CREATE TABLE, or not
      // at all.
      const expected: Record<string, number> = {
        'default.reactions.type': 16,
        'default.reactions.reaction': 5,
        'default.reactions.nsfw': 5,
        'default.reports.type': 2,
        'default.reports.entitytype': 12,
        'default.reports.reason': 7,
        'default.reports.status': 4,
      };
      expect(spec.baseline.size).toBe(expected[spec.column]);
    }
  );

  it.each(COLUMNS.map((c) => [c.column, c] as const))(
    'every %s value the app can emit exists in the column',
    (column, spec) => {
      const arms = effectiveArms(spec);
      const missing = spec.appValues.filter((v) => !arms.has(v));
      expect(
        missing,
        `${column} cannot accept ${missing.length} value(s) the app emits: ${missing.join(
          ', '
        )}.\n` +
          `Source of truth: ${spec.domain}.\n` +
          `The tracker rejects these CLIENT-SIDE while serializing, so the app sees a successful ` +
          `send and the rows never exist. Add them in a migration under ` +
          `src/server/clickhouse/migrations/ that restates the whole enum, then restart the ` +
          `tracker — the DDL alone is inert against pods that already read the schema.`
      ).toEqual([]);
    }
  );

  it.each(COLUMNS.map((c) => [c.column, c] as const))(
    'every migration restating %s reproduces the baseline indices exactly',
    (column, spec) => {
      // `MODIFY COLUMN` REPLACES the definition. A name left out is DROPPED from a live
      // column; a name given a different index silently remaps every existing row. Both are
      // whole-table rewrites the migrations' own headers forbid, and nothing else asserts it.
      const blocks = enumBlocks.filter((b) => b.column === column);
      for (const block of blocks) {
        for (const [name, index] of spec.baseline) {
          expect(
            block.arms.get(name),
            `${block.file}: ${column} restates the enum but ${
              block.arms.has(name)
                ? `moves '${name}' from ${index} to ${block.arms.get(name)}`
                : `drops '${name}'`
            }`
          ).toBe(index);
        }
      }
    }
  );

  it('assigns every value in every parsed enum a distinct index', () => {
    for (const block of enumBlocks) {
      const indices = [...block.arms.values()];
      expect(
        new Set(indices).size,
        `${block.file}: ${block.column} reuses an index — two names would collapse onto one value`
      ).toBe(indices.length);
    }
  });

  /**
   * 🔴 THE COUPLING. `reactions_owner_scores_mv` scores `type IN (<the '*_Create' list>)` as
   * +1 and EVERYTHING ELSE as -1. There is no unknown arm. So adding a '*_Create' value to
   * `reactions.type` without adding it to that list does not fail to count the new reaction —
   * it makes every one of them DECREMENT the owner's score, turning dropped rows (recoverable:
   * nothing was written) into wrong rows in an aggregate with no source to rebuild from.
   *
   * Set EQUALITY in both directions on purpose. A '*_Create' value missing from the list is the
   * corruption above; a name in the list that the column cannot hold is dead weight that reads
   * as coverage. If a future '*_Create' type legitimately must not score +1, change this test
   * deliberately and say why — that is the intended cost of a machine-checkable claim.
   */
  it('scores every reactions.type *_Create value +1 in reactions_owner_scores_mv', () => {
    const reactionsType = COLUMNS.find((c) => c.column === 'default.reactions.type')!;
    const creates = [...effectiveArms(reactionsType).keys()].filter((t) => t.endsWith('_Create'));
    const mv = mvBlocks[mvBlocks.length - 1];

    expect(creates.length, 'no *_Create values parsed out of reactions.type').toBeGreaterThan(0);
    expect(
      [...mv.plusOne].sort(),
      `${mv.file}: the reactions_owner_scores_mv +1 list and the reactions.type '*_Create' ` +
        `values disagree. Anything absent from the list scores -1, so a type in the column but ` +
        `not in the view actively decrements owner scores on every reaction. The column widening ` +
        `and the MODIFY QUERY are ONE operation — apply both or neither.`
    ).toEqual(creates.sort());
  });

  /**
   * The same post-apply marker the `actions.type` guard pins, extended to these columns.
   *
   * 🔴 The DDL is half the operation. `civitai-clickhouse-tracker` builds its column
   * serializers from the schema its pods read AT CONNECT TIME and never re-reads them, so a
   * value added after those pods booted is still rejected client-side: the ALTER verifies
   * perfectly and the value collects ZERO rows. That has shipped broken twice on `actions`
   * alone (see ../migrations/README.md).
   *
   * 🔴 Pinned as an exact string rather than matched on /restart/i because the artifact under
   * test is PROSE, and a guard on words is walkable by rewording. A cosmetic reword fails this
   * on purpose; change the constant, the README and the sibling guard together.
   */
  const POST_APPLY_MARKER =
    '-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.';

  const trackerEnumMigrations = sqlFiles.filter(({ name }) =>
    enumBlocks.some((b) => b.file === name && COLUMNS.some((c) => c.column === b.column))
  );

  it('found migrations touching these columns to check for the marker', () => {
    expect(
      trackerEnumMigrations.length,
      'no migration widening a reactions/reports enum was found — the marker check below ' +
        'would be vacuously true over an empty set'
    ).toBeGreaterThanOrEqual(1);
  });

  it.each(trackerEnumMigrations.map((m) => m.name))(
    '%s carries the POST-APPLY tracker-restart marker verbatim',
    (name) => {
      const raw = trackerEnumMigrations.find((m) => m.name === name)!.raw;
      expect(
        raw.includes(POST_APPLY_MARKER),
        `${name} widens a tracker-written enum but does not carry the post-apply marker.\n` +
          `Add this line verbatim to its header:\n  ${POST_APPLY_MARKER}\n` +
          `Applying the DDL without restarting the tracker ships a value that collects ZERO ` +
          `rows while every signal says it worked — see migrations/README.md.`
      ).toBe(true);
    }
  );
});
