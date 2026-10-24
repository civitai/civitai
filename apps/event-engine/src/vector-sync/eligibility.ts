/**
 * Which media get a vector. One rule table drives both the SQL the reconciler counts with
 * and the row check the consumer and backfill apply, so the two cannot drift.
 */

export type ImageRow = {
  id: number;
  url: string;
  type: 'image' | 'video' | 'audio';
  nsfwLevel: number;
  userId: number;
  postId: number | null;
  sortAt: Date;
  ingestion: string;
  tosViolation: boolean;
  blockedFor: string | null;
  needsReview: string | null;
  minor: boolean;
  poi: boolean;
  sizeKB: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
};

type Rule =
  | { column: keyof ImageRow & string; equals: string | boolean }
  | { column: keyof ImageRow & string; isNull: boolean };

const RULES: Rule[] = [
  { column: 'ingestion', equals: 'Scanned' },
  { column: 'tosViolation', equals: false },
  { column: 'blockedFor', isNull: true },
  { column: 'postId', isNull: false },
  { column: 'needsReview', isNull: true },
  { column: 'minor', equals: false },
  { column: 'poi', equals: false },
];

export function isEligible(row: ImageRow): boolean {
  return RULES.every((rule) => {
    const value = row[rule.column];
    if ('isNull' in rule) return (value === null || value === undefined) === rule.isNull;
    return value === rule.equals;
  });
}

/** The same rules as a SQL predicate over `alias`. */
export function eligibleSql(alias = 'i'): string {
  return RULES.map((rule) => {
    const col = `${alias}."${rule.column}"`;
    if ('isNull' in rule) return `${col} IS ${rule.isNull ? '' : 'NOT '}NULL`;
    if (typeof rule.equals === 'boolean') return `${col} = ${rule.equals}`;
    return `${col} = '${rule.equals}'`;
  }).join(' AND ');
}

export const IMAGE_ROW_COLUMNS = `i.id, i.url, i.type, i."nsfwLevel", i."userId", i."postId", i."sortAt",
  i.ingestion, i."tosViolation", i."blockedFor", i."needsReview", i.minor, i.poi, i."sizeKB",
  COALESCE(i.width, CASE WHEN jsonb_typeof(i.metadata->'width') = 'number' THEN (i.metadata->>'width')::numeric::int END) AS width,
  COALESCE(i.height, CASE WHEN jsonb_typeof(i.metadata->'height') = 'number' THEN (i.metadata->>'height')::numeric::int END) AS height,
  CASE WHEN jsonb_typeof(i.metadata->'duration') = 'number' THEN (i.metadata->>'duration')::float END AS duration`;
