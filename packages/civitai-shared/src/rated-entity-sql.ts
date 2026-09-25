import { getHighestBrowsingLevelBit, NsfwLevel, nsfwBrowsingLevelsFlag } from './browsing-levels';

export type ScanFloorEntityType = 'Article' | 'Post' | 'Bounty' | 'BountyEntry';
export type DerivedNsfwEntityType = 'Post' | 'Bounty' | 'BountyEntry';

const SCAN_FLOOR_ENTITY_TYPES: readonly string[] = ['Article', 'Post', 'Bounty', 'BountyEntry'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const INTERNAL_ALIASES = new Set(['i', 'ic', 'em', 'd', 'ar', 'r']);

// Both apps inline these strings as raw SQL, so every input is checked against a closed set.
function identifier(value: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`Not a SQL identifier: ${value}`);
  return value;
}

function floorEntityType(value: string) {
  if (!SCAN_FLOOR_ENTITY_TYPES.includes(value)) throw new Error(`No scan floor for ${value}`);
  return value;
}

export function textScanVerdictPredicateText(alias: string, minLevel: number = NsfwLevel.PG13) {
  if (!Number.isInteger(minLevel)) throw new Error(`Not an integer level: ${minLevel}`);
  const a = identifier(alias);
  return `${a}.result->>'version' IS NOT NULL AND ${a}."nsfwLevel" >= ${minLevel}`;
}

export function scanFloorText(entityType: ScanFloorEntityType, idColumn: string) {
  return `COALESCE((SELECT em."nsfwLevel" FROM "EntityModeration" em WHERE em."entityType" = '${floorEntityType(
    entityType
  )}' AND em."entityId" = ${identifier(idColumn)} AND ${textScanVerdictPredicateText('em')}), 0)`;
}

export function raiseNsfwLevelText(level: string, floor: string) {
  const l = identifier(level);
  const f = identifier(floor);
  return `(CASE WHEN ${l} = 0 OR ${f} = 0 THEN ${l} WHEN (${l} & ~(${f} - 1)) = 0 THEN ${f} ELSE ${l} & ~(${f} - 1) END)`;
}

export function articleModerationFloorText(idColumn: string) {
  const id = identifier(idColumn);
  return `GREATEST(CASE WHEN EXISTS (SELECT 1 FROM "EntityModeration" em WHERE em."entityType" = 'Article' AND em."entityId" = ${id} AND em.result->>'version' IS NULL AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))) OR EXISTS (SELECT 1 FROM "ArticleReport" ar JOIN "Report" r ON r.id = ar."reportId" WHERE ar."articleId" = ${id} AND r.reason = 'NSFW'::"ReportReason" AND r.status = 'Actioned'::"ReportStatus") THEN ${
    NsfwLevel.R
  } ELSE 0 END, ${scanFloorText('Article', id)})`;
}

const imageLevelText: Record<DerivedNsfwEntityType, (alias: string) => string> = {
  Post: (a) => `(SELECT bit_or(i."nsfwLevel") FROM "Image" i WHERE i."postId" = ${a}.id)`,
  Bounty: (a) =>
    `(SELECT bit_or(i."nsfwLevel") FROM "ImageConnection" ic JOIN "Image" i ON i.id = ic."imageId" WHERE ic."entityType" = 'Bounty' AND ic."entityId" = ${a}.id)`,
  BountyEntry: (a) =>
    `(SELECT bit_or(i."nsfwLevel") FROM "ImageConnection" ic JOIN "Image" i ON i.id = ic."imageId" WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" = ${a}.id)`,
};

export function ratedEntityContentNsfwLevelText(entityType: DerivedNsfwEntityType, alias: string) {
  const images = imageLevelText[entityType];
  if (!images) throw new Error(`No derived level for ${entityType}`);
  const a = identifier(alias);
  if (INTERNAL_ALIASES.has(a)) throw new Error(`Alias ${a} is used inside the derived level`);
  return `(SELECT ${raiseNsfwLevelText('d.l', 'd.f')} FROM (SELECT COALESCE(${images(
    a
  )}, 0) AS l, ${scanFloorText(entityType, `${a}.id`)} AS f) d)`;
}

export function ratedEntityDerivedNsfwLevelText(entityType: DerivedNsfwEntityType, alias: string) {
  const content = ratedEntityContentNsfwLevelText(entityType, alias);
  return entityType === 'Bounty'
    ? `(CASE WHEN ${identifier(alias)}.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag} ELSE ${content} END)`
    : content;
}

export function textScanRaisedMinLevel(entityType: string) {
  return entityType === 'Model' ? NsfwLevel.R : NsfwLevel.PG13;
}

export function isTextScanRaised(row: { entityType: string; nsfwLevel: number | null; result: unknown }) {
  const version = (row.result as { version?: unknown } | null)?.version;
  return version != null && row.nsfwLevel != null && row.nsfwLevel >= textScanRaisedMinLevel(row.entityType);
}

export function challengeDerivedNsfwLevel(allowedNsfwLevel: number) {
  return getHighestBrowsingLevelBit(allowedNsfwLevel) || NsfwLevel.PG;
}

export function overrideBasisDropped({
  moderatorNsfwLevel,
  moderatorNsfwLevelBasis,
  derivedLevel,
}: {
  moderatorNsfwLevel: number | null;
  moderatorNsfwLevelBasis: number | null;
  derivedLevel: number | null;
}) {
  if (moderatorNsfwLevel == null || moderatorNsfwLevelBasis == null || !derivedLevel) return false;
  return getHighestBrowsingLevelBit(derivedLevel) < getHighestBrowsingLevelBit(moderatorNsfwLevelBasis);
}

export type BountyBuzzKind = 'green' | 'yellow' | 'unknown';

// Before buzzType was stored, a green bounty was recognisable only by its nsfw lock, which a
// moderator's lock also produces. Keep in step with greenBountyPredicateText.
export function bountyBuzzType(bounty: {
  buzzType: string | null;
  nsfw: boolean;
  lockedProperties: string[];
}): BountyBuzzKind {
  if (bounty.buzzType === 'green' || bounty.buzzType === 'yellow') return bounty.buzzType;
  return !bounty.nsfw && bounty.lockedProperties.includes('nsfw') ? 'unknown' : 'yellow';
}

// True for every bounty bountyBuzzType does not call yellow: green Buzz must never fund R+.
export function greenBountyPredicateText(alias: string) {
  const a = identifier(alias);
  return `(${a}."buzzType" = 'green' OR (${a}."buzzType" IS NULL AND ${a}.nsfw = FALSE AND 'nsfw' = ANY(${a}."lockedProperties")))`;
}

