import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { jsonField, parseForm, parseQuery } from '$lib/server/query';
import {
  DraftError,
  getDraft,
  listDrafts,
  validateDraftPrompts,
  type DraftPrompts,
} from '$lib/server/text-scan-lab/drafts.service';
import { parseEntityIds } from '$lib/server/text-scan-lab/entity-ids';
import { refused } from '$lib/server/text-scan-lab/errors';
import {
  LabHarnessError,
  composeEntities,
  getPrompts,
  quoteTexts,
  scanTexts,
} from '$lib/server/text-scan-lab/harness-client';
import { listSets } from '$lib/server/text-scan-lab/test-sets.service';
import { confirmedOrQuote, quoteStamp } from '$lib/server/text-scan-lab/quote';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { HARNESS_LIMITS } from '$lib/text-scan-lab/limits';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type LabEntityType,
  type LabField,
  type LabScanResult,
  type LabText,
} from '$lib/text-scan-lab/types';

/** One run is one harness request's worth of items. */
const MAX_ITEMS = HARNESS_LIMITS.textsPerRequest;

const querySchema = z.object({
  draft: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const q = parseQuery(url, querySchema);
  const [drafts, sets, active] = await Promise.all([
    listDrafts(),
    // Saving posts to the set page's action, which the page grant gates as well.
    locals.grants['textScan.testSet.edit'] && canAccess(locals.user, '/text-scan/test-sets')
      ? listSets()
      : [],
    // Only pre-fills an inline override; the page works without it.
    getPrompts().then(
      (p) => Object.fromEntries(Object.entries(p.active).map(([k, v]) => [k, v.content])),
      () => null
    ),
  ]);
  return {
    drafts: drafts.map((d) => ({
      id: d.id,
      name: d.name,
      keys: PROMPT_KEYS.filter((k) => k in d.prompts),
      published: d.publishedAt !== null,
    })),
    testSets: sets.map((s) => ({ id: s.id, name: s.name })),
    selectedDraftId: drafts.some((d) => d.id === q.draft) ? q.draft ?? null : null,
    activePrompts: active as Record<string, string> | null,
    wide: true,
  };
};

const runSchema = z.object({
  entityType: z.enum(LAB_ENTITY_TYPES),
  mode: z.enum(['text', 'entities']),
  fields: jsonField(z.array(z.object({ heading: z.string(), text: z.string() }))).optional(),
  ids: z.string().optional(),
  version: z.enum(['draft', 'inline']),
  draftId: z
    .string()
    .regex(/^\d*$/, 'Invalid draft.')
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),
  overrides: jsonField(z.record(z.string(), z.unknown())).optional(),
});

type RunItem = {
  key: string;
  title: string;
  fields: LabField[];
  /** Null for free text. */
  entityId: number | null;
  authorId: number | null;
};
type Skipped = { entityId: number; error: string };

async function buildItems(
  entityType: LabEntityType,
  input: z.infer<typeof runSchema>
): Promise<{ items: RunItem[]; skipped: Skipped[] } | string> {
  if (input.mode === 'text') {
    const fields = normaliseLabFields(input.fields ?? []);
    if (typeof fields === 'string') return fields;
    if (!fields.length) return 'Enter some text to scan.';
    return {
      items: [{ key: 'text', title: 'Free text', fields, entityId: null, authorId: null }],
      skipped: [],
    };
  }
  const ids = parseEntityIds(input.ids ?? '', MAX_ITEMS);
  if (typeof ids === 'string') return ids;
  const composed = await composeEntities(entityType, ids);
  const items: RunItem[] = [];
  const skipped: Skipped[] = [];
  for (const c of composed) {
    if (c.ok)
      items.push({
        key: String(c.entityId),
        title: `${entityType} ${c.entityId}`,
        fields: c.fields,
        entityId: c.entityId,
        authorId: c.userId,
      });
    else skipped.push({ entityId: c.entityId, error: c.error });
  }
  return { items, skipped };
}

/** Version B's prompts. Every key the moderator included is sent: the harness runs active for an
 *  absent key, so a blanked key dropped here would silently compare active against active. */
async function versionB(
  input: z.infer<typeof runSchema>
): Promise<
  | { overrides: DraftPrompts; name: string; draftUpdatedAt: Date | null }
  | { status: number; error: string }
> {
  try {
    if (input.version === 'inline') {
      const overrides = validateDraftPrompts(input.overrides ?? {});
      if (!Object.keys(overrides).length)
        return { status: 400, error: 'Add at least one prompt key to override.' };
      return { overrides, name: 'Inline overrides', draftUpdatedAt: null };
    }
    if (!input.draftId) return { status: 400, error: 'Choose a draft for version B.' };
    const draft = await getDraft(input.draftId);
    if (!draft) return { status: 404, error: `Draft ${input.draftId} not found.` };
    const overrides = validateDraftPrompts(draft.prompts);
    if (!Object.keys(overrides).length)
      return {
        status: 400,
        error: `Draft "${draft.name}" overrides no prompt — it would run active.`,
      };
    return { overrides, name: `Draft · ${draft.name}`, draftUpdatedAt: draft.updatedAt };
  } catch (e) {
    if (e instanceof DraftError) return { status: e.status, error: e.message };
    throw e;
  }
}

export type RunItemResult = RunItem & { a: LabScanResult; b: LabScanResult };

export const actions: Actions = {
  run: async ({ request }) => {
    const form = await request.formData();
    const input = parseForm(runSchema, form);
    if (typeof input === 'string') return fail(400, { error: input });
    const { entityType } = input;

    const b = await versionB(input);
    if ('error' in b) return fail(b.status, { error: b.error });

    let built: Awaited<ReturnType<typeof buildItems>>;
    try {
      built = await buildItems(entityType, input);
    } catch (e) {
      return refused(e);
    }
    if (typeof built === 'string') return fail(400, { error: built });
    const { items, skipped } = built;
    if (!items.length)
      return fail(400, {
        error: `Nothing to scan: ${skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.`,
      });

    const texts: LabText[] = items.map(({ key, fields }) => ({ key, fields }));
    try {
      const quote = await confirmedOrQuote(form, {
        count: texts.length,
        stamp: quoteStamp(texts.length, b.draftUpdatedAt),
        quote: async () => {
          const [qa, qb] = await Promise.all([
            quoteTexts(entityType, texts),
            quoteTexts(entityType, texts, b.overrides),
          ]);
          // An unquoted side is an unknown cost, not a free one.
          const cost =
            qa.meanCostTotal === null || qb.meanCostTotal === null
              ? null
              : (qa.meanCostTotal + qb.meanCostTotal) * texts.length;
          return { cost, skipped };
        },
      });
      if (quote) return quote;

      // Settled, not all: a side that succeeded was billed, so its results are shown even when the
      // other side's request failed outright.
      const [sa, sb] = await Promise.allSettled([
        scanTexts(entityType, texts),
        scanTexts(entityType, texts, b.overrides),
      ]);
      if (sa.status === 'rejected' && sb.status === 'rejected') throw sa.reason;
      const sideError = (s: PromiseSettledResult<LabScanResult[]>) => {
        if (s.status === 'fulfilled') return null;
        if (s.reason instanceof LabHarnessError) return s.reason.message;
        console.error('text-scan playground: scan side failed', s.reason);
        return 'The scan request failed unexpectedly.';
      };
      const errorA = sideError(sa);
      const errorB = sideError(sb);
      const missing = (key: string, sideFailure: string | null): LabScanResult => ({
        key,
        ok: false,
        error: sideFailure ?? 'No result returned for this item.',
      });
      const byKey = (s: PromiseSettledResult<LabScanResult[]>) =>
        new Map(s.status === 'fulfilled' ? s.value.map((r) => [r.key, r]) : []);
      const aByKey = byKey(sa);
      const bByKey = byKey(sb);
      const results: RunItemResult[] = items.map((item) => ({
        ...item,
        a: aByKey.get(item.key) ?? missing(item.key, errorA),
        b: bByKey.get(item.key) ?? missing(item.key, errorB),
      }));
      return {
        ran: true as const,
        entityType,
        labels: LAB_LABELS[entityType],
        versionB: { name: b.name, keys: PROMPT_KEYS.filter((k) => k in b.overrides) },
        items: results,
        skipped,
        errors: { a: errorA, b: errorB },
      };
    } catch (e) {
      return refused(e);
    }
  },
};
