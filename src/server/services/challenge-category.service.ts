import { TRPCError } from '@trpc/server';
import type {
  ChallengeJudgingCategory,
  UpsertChallengeCategoryInput,
} from '~/server/schema/challenge.schema';
import {
  CHALLENGE_CATEGORY_KEYS,
  CHALLENGE_PRESET_CATEGORIES,
} from '~/shared/constants/challenge.constants';

// The judging-category library lives in the ChallengeCategory table (docs/features/
// dynamic-challenge-judging-categories.md §5.1, D-DB): label/group/criteria feed the client
// picker, rubric/rubricNsfw are server-only LLM prompt content (same handling as
// ChallengeJudge prompts). Everything here degrades to the preset constants when the table is
// missing or unseeded, so code can deploy before the manual per-env migration/seed.

export type ChallengeCategoryRow = {
  key: string;
  label: string;
  group: string;
  criteria: string;
  rubric: string | null;
  rubricNsfw: string | null;
  sortOrder: number;
  active: boolean;
};

export type ChallengeCategoryOption = Pick<
  ChallengeCategoryRow,
  'key' | 'label' | 'group' | 'criteria'
>;

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { rows: ChallengeCategoryRow[]; fetchedAt: number } | null = null;

function presetFallbackRows(): ChallengeCategoryRow[] {
  return CHALLENGE_CATEGORY_KEYS.map((key, i) => ({
    key,
    label: CHALLENGE_PRESET_CATEGORIES[key].label,
    group: CHALLENGE_PRESET_CATEGORIES[key].group,
    criteria: CHALLENGE_PRESET_CATEGORIES[key].criteria,
    rubric: null,
    rubricNsfw: null,
    sortOrder: i * 10,
    active: true,
  }));
}

// Preset baseline unioned with DB rows: DB rows override/add by key, presets fill the rest, sorted
// by (sortOrder, label). Keeps the mandatory presets (esp. `theme`) structurally present regardless
// of table state — a partially-populated library can never orphan them — so persistence stays a
// plain single-row upsert and the library has one, DB-authoritative-where-set, source of truth.
export function mergeCategoryRows(
  base: ChallengeCategoryRow[],
  overrides: ChallengeCategoryRow[]
): ChallengeCategoryRow[] {
  const byKey = new Map(base.map((r) => [r.key, r]));
  for (const r of overrides) byKey.set(r.key, r);
  return [...byKey.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)
  );
}

// dbRead is imported lazily so unit tests can import this module (and its consumers, e.g.
// generative-content.ts) without pulling the Prisma client + server env into the module graph.
async function getChallengeCategoryRows(): Promise<ChallengeCategoryRow[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  let dbRows: ChallengeCategoryRow[] = [];
  try {
    const { dbRead } = await import('~/server/db/client');
    dbRows = await dbRead.challengeCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  } catch {
    // Table may not exist in this env yet (migrations are applied manually), or the read failed
    // transiently. Serve the freshest data available WITHOUT caching, so a blip doesn't make
    // resolveJudgingCategories reject valid category keys for a full TTL; an expired cache
    // beats the preset fallback.
    return cache?.rows ?? presetFallbackRows();
  }
  cache = { rows: mergeCategoryRows(presetFallbackRows(), dbRows), fetchedAt: Date.now() };
  return cache.rows;
}

export function clearChallengeCategoryCache() {
  cache = null;
}

// Every challenge's judgingCategories requires exactly one `theme` (judgingCategoryRefinements),
// so the theme category must never be soft-hidden or removed — it would break create for all users.
export function assertCategoryActiveAllowed(key: string, active: boolean) {
  if (key === 'theme' && !active)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The theme category cannot be deactivated.',
    });
}

/** Category list for the picker — key/label/group/criteria only (prompt content stays server-side). */
export async function getJudgingCategoryOptions(): Promise<ChallengeCategoryOption[]> {
  const rows = await getChallengeCategoryRows();
  return rows
    .filter((r) => r.active)
    .map(({ key, label, group, criteria }) => ({ key, label, group, criteria }));
}

/**
 * Resolve client-submitted `{ key, weight }` rows into the persisted judging-category shape,
 * deriving label + criteria server-side from the category library so client-sent text can never
 * reach the AI judge. Throws on unknown or inactive keys.
 */
export async function resolveJudgingCategories(
  categories: { key: string; weight: number }[]
): Promise<ChallengeJudgingCategory[]> {
  const rows = await getChallengeCategoryRows();
  const byKey = new Map(rows.filter((r) => r.active).map((r) => [r.key, r]));
  return categories.map(({ key, weight }) => {
    const row = byKey.get(key);
    if (!row)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Unknown judging category: ${key}`,
      });
    return { key, weight, label: row.label, criteria: row.criteria };
  });
}

/**
 * Rich scoring rubric for one category. Precedence: DB NSFW override (when `nsfw`) → DB rubric →
 * text derived from label + criteria. The rich rubric text lives only in the DB (seeded manually
 * per env); an unseeded env degrades to the terse criteria-derived form. Always non-empty for any
 * category that has at least a label.
 */
export function pickCategoryRubric(
  row: ChallengeCategoryRow | undefined,
  category: { key: string; name?: string; criteria?: string },
  opts?: { nsfw?: boolean }
): string {
  if (opts?.nsfw && row?.rubricNsfw) return row.rubricNsfw;
  if (row?.rubric) return row.rubric;
  const label = row?.label ?? category.name ?? category.key;
  const criteria = row?.criteria ?? category.criteria ?? '';
  return `${label.toUpperCase()} SCORING (0-10):\n${criteria}`.trim();
}

/** Concatenated rubric block for the selected categories, for `{{SCORING_RUBRICS}}` injection. */
export async function resolveRubricBlock(
  categories: { key: string; name?: string; criteria?: string }[],
  opts?: { nsfw?: boolean }
): Promise<string> {
  const rows = await getChallengeCategoryRows();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return categories.map((c) => pickCategoryRubric(byKey.get(c.key), c, opts)).join('\n\n');
}

const CATEGORY_ROW_SELECT = {
  key: true,
  label: true,
  group: true,
  criteria: true,
  rubric: true,
  rubricNsfw: true,
  sortOrder: true,
  active: true,
} as const;

/** Full category rows incl. server-only rubric text — MODERATOR ONLY. Reads fresh (bypasses the
 *  public 5-min cache) so the playground always shows current state. */
export async function getChallengeCategoriesFull(): Promise<ChallengeCategoryRow[]> {
  const { dbRead } = await import('~/server/db/client');
  return dbRead.challengeCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    select: CATEGORY_ROW_SELECT,
  });
}

/** Create or update a category library row, then bust the in-process category cache. In-process
 *  only — other instances refresh within the 5-min TTL (acceptable for a mod config surface). */
export async function upsertChallengeCategory(
  input: UpsertChallengeCategoryInput
): Promise<ChallengeCategoryRow> {
  assertCategoryActiveAllowed(input.key, input.active);
  const { dbWrite } = await import('~/server/db/client');
  const { key, ...data } = input;
  // Plain single-row upsert — getChallengeCategoryRows unions the preset baseline over DB rows, so
  // creating one row can never orphan the mandatory `theme`/presets (no pre-seed needed here).
  const row = await dbWrite.challengeCategory.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
    select: CATEGORY_ROW_SELECT,
  });
  clearChallengeCategoryCache();
  return row;
}
