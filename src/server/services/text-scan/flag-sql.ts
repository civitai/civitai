import { Prisma } from '@prisma/client';
import {
  MAX_FLAG_RULINGS,
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';

// SQL fragments over `Model.meta.textScanFlags[label]` for statements aliased `m`. A leaf module: the
// stamps in appeal-text-hash and the flag writers in model-poi-minor build the same entry shape.

// Labels are the closed TextScanFlagLabel union, so interpolating them as literals is safe.
export const labelLiteral = (label: TextScanFlagLabel) => Prisma.raw(`'${label}'`);
// A label is a literal, or a SQL expression for statements that stamp several labels at once.
export type LabelRef = TextScanFlagLabel | Prisma.Sql;
const labelRef = (label: LabelRef) => (typeof label === 'string' ? labelLiteral(label) : label);
export const flagEntryPath = (label: LabelRef) =>
  Prisma.sql`(m.meta->${TEXT_SCAN_FLAGS_KEY}->${labelRef(label)})`;

// A write that replaces or overwrites a decision on the label entry moves the old one into a bounded
// history instead of dropping it. `carry` names the decisions being superseded; empty when there is
// nothing to carry. The live decision keeps its note; history is copied whole into `rulings[]` up to
// 5 deep, so a note there would ride every feed row several times over.
export const carriedRulings = (
  label: LabelRef,
  carry: ('appealGranted' | 'appealUpheld')[] = ['appealGranted', 'appealUpheld']
) => {
  const prev = flagEntryPath(label);
  const decision = (key: 'appealGranted' | 'appealUpheld') =>
    carry.includes(key)
      ? Prisma.sql`UNION ALL SELECT ((${prev}->${Prisma.raw(`'${key}'`)}) - 'note') || ${Prisma.raw(
          `'{"decision":"${key}"}'`
        )}::jsonb WHERE ${prev}->${Prisma.raw(`'${key}'`)} IS NOT NULL`
      : Prisma.empty;
  return Prisma.sql`COALESCE((
    SELECT jsonb_build_object('rulings', jsonb_agg(r.d ORDER BY r.d->>'at'))
    FROM (
      SELECT x.d FROM (
        SELECT jsonb_array_elements(COALESCE(${prev}->'rulings', '[]'::jsonb)) AS d
        ${decision('appealGranted')}
        ${decision('appealUpheld')}
      ) x
      ORDER BY x.d->>'at' DESC LIMIT ${Prisma.raw(String(MAX_FLAG_RULINGS))}
    ) r
    HAVING count(*) > 0
  ), '{}'::jsonb)`;
};
