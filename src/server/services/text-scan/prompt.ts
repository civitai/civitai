import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import {
  isTextScanWebSearchEntityType,
  parseTextScanRollout,
  readTextScanCsamMode,
  readTextScanLabelModes,
  readTextScanRollouts,
  readTextScanWebSearchRollouts,
  resetTextScanRolloutCache,
  TEXT_SCAN_CSAM_MODE_FIELD,
  type TextScanCsamMode,
  type TextScanLabelMode,
  type TextScanRollout,
} from '~/server/services/text-scan/mode';
import {
  TEXT_SCAN_FLAG_LABELS,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { composeUserText, segmentUserText } from '~/server/services/text-scan/segment';
import type {
  PromptIds,
  TextScanEntityType,
  TextScanLabel,
  TextScanSubject,
} from '~/server/services/text-scan/types';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
} from '~/server/utils/errorHandling';

/** An orchestrator alias: it can be repointed without a deploy, and the content hash will not see it move. */
export const DEFAULT_TEXT_SCAN_MODEL = 'civitai/qwen3.8';
const DEFAULT_MAX_INPUT_CHARS = 200000;
const DEFAULT_MAX_SEGMENTS = 10;
/** Each segment is a billed call; bounds a bad config override. */
export const MAX_SEGMENTS_LIMIT = 20;

export type TextScanConfig = {
  model: string;
  /** Per-call budget; longer text is split into segments of this size. */
  maxInputChars: number;
  /** The most calls one scan makes; text past them is not scanned and the result says so. */
  maxSegments: number;
  thinking: boolean;
};

function withDefaults(raw: unknown): TextScanConfig {
  const config: TextScanConfig = {
    model: DEFAULT_TEXT_SCAN_MODEL,
    maxInputChars: DEFAULT_MAX_INPUT_CHARS,
    maxSegments: DEFAULT_MAX_SEGMENTS,
    thinking: false,
  };
  if (!raw || typeof raw !== 'object') return config;
  const parsed = raw as Partial<Record<keyof TextScanConfig, unknown>>;
  if (typeof parsed.model === 'string' && parsed.model) config.model = parsed.model;
  if (Number.isInteger(parsed.maxInputChars) && (parsed.maxInputChars as number) > 0)
    config.maxInputChars = parsed.maxInputChars as number;
  const maxSegments = parsed.maxSegments as number;
  if (Number.isInteger(maxSegments) && maxSegments >= 1 && maxSegments <= MAX_SEGMENTS_LIMIT)
    config.maxSegments = maxSegments;
  if (typeof parsed.thinking === 'boolean') config.thinking = parsed.thinking;
  return config;
}

async function readStoredConfig(): Promise<unknown> {
  const raw = await withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.TEXT_SCAN.CONFIG));
  return raw ? JSON.parse(raw) : null;
}

export async function getTextScanConfig(): Promise<TextScanConfig> {
  try {
    return withDefaults(await readStoredConfig());
  } catch {
    // A broken or unreachable config must not stop scanning; defaults are the documented baseline.
    return withDefaults(null);
  }
}

async function assertActiveModerator(userId: number) {
  const user = await dbRead.user.findFirst({
    where: { id: userId, isModerator: true, deletedAt: null, bannedAt: null },
    select: { id: true },
  });
  if (!user) throwAuthorizationError(`user ${userId} is not an active moderator`);
}

export async function setTextScanConfig(
  patch: Partial<TextScanConfig>,
  { moderatorId }: { moderatorId: number }
) {
  await assertActiveModerator(moderatorId);
  // No fallback here: merging a patch over defaults would silently erase the stored overrides.
  const next = withDefaults({ ...withDefaults(await readStoredConfig()), ...patch });
  await sysRedis.set(REDIS_SYS_KEYS.TEXT_SCAN.CONFIG, JSON.stringify(next));
  await logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'config updated',
    moderatorId,
    config: next,
  });
  return next;
}

/**
 * `null` removes the entity type's field, which is off. Any `active` share needs `allowActive`:
 * shadow is the default step, and going live is a separate, deliberate call. Other pods pick the
 * change up within the 15s rollout cache.
 */
export async function setTextScanRollout(
  entityType: TextScanEntityType,
  rollout: TextScanRollout | null,
  { moderatorId, allowActive = false }: { moderatorId: number; allowActive?: boolean }
) {
  await assertActiveModerator(moderatorId);
  if (rollout && rollout.active > 0 && !allowActive)
    throw throwBadRequestError(`${entityType}: an active share needs allowActive`);
  if (rollout) {
    const value = parseTextScanRollout(JSON.stringify(rollout));
    await sysRedis.hSet(REDIS_SYS_KEYS.TEXT_SCAN.MODES, entityType, JSON.stringify(value));
  } else {
    await sysRedis.hDel(REDIS_SYS_KEYS.TEXT_SCAN.MODES, entityType);
  }
  resetTextScanRolloutCache();
  await logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'rollout updated',
    moderatorId,
    entityType,
    rollout,
  });
  return readTextScanRollouts();
}

/** As `setTextScanRollout`, for the web-search pass. Only Model is eligible. */
export async function setTextScanWebSearchRollout(
  entityType: TextScanEntityType,
  rollout: TextScanRollout | null,
  { moderatorId, allowActive = false }: { moderatorId: number; allowActive?: boolean }
) {
  if (!isTextScanWebSearchEntityType(entityType))
    throw throwBadRequestError(`${entityType}: web search is only available for Model`);
  await assertActiveModerator(moderatorId);
  if (rollout && rollout.active > 0 && !allowActive)
    throw throwBadRequestError(`${entityType}: an active share needs allowActive`);
  if (rollout) {
    const value = parseTextScanRollout(JSON.stringify(rollout));
    await sysRedis.hSet(REDIS_SYS_KEYS.TEXT_SCAN.WEB_SEARCH, entityType, JSON.stringify(value));
  } else {
    await sysRedis.hDel(REDIS_SYS_KEYS.TEXT_SCAN.WEB_SEARCH, entityType);
  }
  resetTextScanRolloutCache();
  await logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'web-search rollout updated',
    moderatorId,
    entityType,
    rollout,
  });
  return readTextScanWebSearchRollouts();
}

/** `auto` removes the field. Other pods pick the change up within the 15s rollout cache. */
export async function setTextScanLabelMode(
  label: TextScanFlagLabel,
  mode: TextScanLabelMode,
  { moderatorId }: { moderatorId: number }
) {
  if (!(TEXT_SCAN_FLAG_LABELS as readonly string[]).includes(label))
    throw throwBadRequestError(`${label}: only poi and minor have a label mode`);
  await assertActiveModerator(moderatorId);
  if (mode === 'review') await sysRedis.hSet(REDIS_SYS_KEYS.TEXT_SCAN.LABEL_MODES, label, 'review');
  else await sysRedis.hDel(REDIS_SYS_KEYS.TEXT_SCAN.LABEL_MODES, label);
  resetTextScanRolloutCache();
  await logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'label mode updated',
    moderatorId,
    label,
    mode,
  });
  return readTextScanLabelModes();
}

/** `off` removes the field, so a missing field and an explicit off read the same. */
export async function setTextScanCsamMode(
  mode: TextScanCsamMode,
  { moderatorId }: { moderatorId: number }
) {
  if (mode !== 'off' && mode !== 'review')
    throw throwBadRequestError(`csam has no ${String(mode)} mode: only off and review`);
  await assertActiveModerator(moderatorId);
  if (mode === 'review' && !(await getActiveTextScanPrompts())['label:csam']?.content?.trim())
    throw throwBadRequestError('csam review needs an active label:csam prompt; save one first');
  if (mode === 'review')
    await sysRedis.hSet(REDIS_SYS_KEYS.TEXT_SCAN.LABEL_MODES, TEXT_SCAN_CSAM_MODE_FIELD, 'review');
  else await sysRedis.hDel(REDIS_SYS_KEYS.TEXT_SCAN.LABEL_MODES, TEXT_SCAN_CSAM_MODE_FIELD);
  resetTextScanRolloutCache();
  await logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'label mode updated',
    moderatorId,
    label: TEXT_SCAN_CSAM_MODE_FIELD,
    mode,
  });
  return readTextScanCsamMode();
}

export type ActiveTextScanPrompt = { id: number; key: string; content: string };

export const TEXT_SCAN_PROMPT_KEY = /^(base|label:(nsfw|poi|minor|scam|csam))$/;

export async function getActiveTextScanPrompts(): Promise<Record<string, ActiveTextScanPrompt>> {
  return fetchThroughCache(
    REDIS_KEYS.CACHES.TEXT_SCAN_PROMPTS,
    async () => {
      // dbWrite: the cache is busted right after an insert, and a replica read here would
      // re-cache the previous version for the full TTL.
      const rows = await dbWrite.$queryRaw<ActiveTextScanPrompt[]>`
        SELECT DISTINCT ON ("key") id, "key", content
        FROM "TextScanPrompt"
        ORDER BY "key", id DESC
      `;
      return Object.fromEntries(rows.map((row) => [row.key, row]));
    },
    { ttl: 300 }
  );
}

export async function insertTextScanPrompt({
  key,
  content,
  note,
  createdById,
  baseId,
}: {
  key: string;
  content: string;
  note?: string;
  createdById: number;
  /** The version the edit started from; null when there was none. Given, the insert happens only
   *  while it is still the newest version of `key`. */
  baseId?: number | null;
}) {
  if (!TEXT_SCAN_PROMPT_KEY.test(key)) throwBadRequestError(`Invalid text-scan prompt key: ${key}`);
  await assertActiveModerator(createdById);
  const data = { key, content, note, createdById };
  const select = { id: true, key: true } as const;
  const row =
    baseId === undefined
      ? await dbWrite.textScanPrompt.create({ data, select })
      : await dbWrite.$transaction(async (tx) => {
          // Serialises saves of one key, so two saves from the same base cannot both insert as newest.
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`TextScanPrompt:${key}`}))`;
          const newest = await tx.textScanPrompt.findFirst({
            where: { key },
            orderBy: { id: 'desc' },
            select: { id: true },
          });
          if ((newest?.id ?? null) !== baseId)
            throwConflictError(
              `A newer version of ${key}${
                newest ? ` (#${newest.id})` : ''
              } was saved after this edit started.`
            );
          return tx.textScanPrompt.create({ data, select });
        });
  await bustFetchThroughCache(REDIS_KEYS.CACHES.TEXT_SCAN_PROMPTS);
  return row;
}

export class MissingTextScanPromptError extends Error {
  constructor(public keys: string[]) {
    super(`Missing text-scan prompt rows: ${keys.join(', ')}`);
  }
}

export function subjectTextLength(subject: TextScanSubject) {
  return subject.fields.reduce((sum, field) => sum + (field.text?.trim().length ?? 0), 0);
}

export function composeTextScanMessages({
  prompts,
  labels,
  subject,
  maxInputChars,
  maxSegments,
}: {
  prompts: Record<string, ActiveTextScanPrompt>;
  labels: TextScanLabel[];
  subject: TextScanSubject;
  maxInputChars: number;
  maxSegments: number;
}) {
  const keys = ['base', ...labels.map((label) => `label:${label}`)];
  // A blank row would compose an empty definition and be submitted everywhere; treat it as missing.
  const missing = keys.filter((key) => !prompts[key]?.content?.trim());
  if (missing.length) throw new MissingTextScanPromptError(missing);

  const labelSection = (label: TextScanLabel) =>
    `## Label: ${label}\n${prompts[`label:${label}`].content}`;
  const system = [prompts.base.content, ...labels.map(labelSection)].join('\n\n');

  const promptIds: PromptIds = { base: prompts.base.id };
  for (const label of labels) promptIds[label] = prompts[`label:${label}`].id;

  const { text, segments, inputChars, scannedChars, inputCut } = segmentUserText(subject, {
    budget: maxInputChars,
    maxSegments,
  });
  return {
    system,
    text,
    segments,
    promptIds,
    inputChars,
    scannedChars,
    inputCut,
  };
}

/** Uncapped and prompt-independent, unlike the dedup hash: appeal and re-file gates compare it. */
export function textScanTextHash(subject: TextScanSubject) {
  return hashContent(composeUserText(subject));
}
