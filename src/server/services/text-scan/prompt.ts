import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import type { PromptIds, TextScanLabel, TextScanSubject } from '~/server/services/text-scan/types';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export const DEFAULT_TEXT_SCAN_MODEL =
  'urn:air:qwen3:repository:huggingface:gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090@main.tar';
const DEFAULT_MAX_INPUT_CHARS = 12000;

export type TextScanConfig = { model: string; maxInputChars: number; thinking: boolean };

function withDefaults(raw: unknown): TextScanConfig {
  const config: TextScanConfig = {
    model: DEFAULT_TEXT_SCAN_MODEL,
    maxInputChars: DEFAULT_MAX_INPUT_CHARS,
    thinking: false,
  };
  if (!raw || typeof raw !== 'object') return config;
  const parsed = raw as Partial<Record<keyof TextScanConfig, unknown>>;
  if (typeof parsed.model === 'string' && parsed.model) config.model = parsed.model;
  if (Number.isInteger(parsed.maxInputChars) && (parsed.maxInputChars as number) > 0)
    config.maxInputChars = parsed.maxInputChars as number;
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

export type ActiveTextScanPrompt = { id: number; key: string; content: string };

export const TEXT_SCAN_PROMPT_KEY = /^(base|label:(nsfw|poi|minor|scam))$/;

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
}: {
  key: string;
  content: string;
  note?: string;
  createdById: number;
}) {
  if (!TEXT_SCAN_PROMPT_KEY.test(key)) throwBadRequestError(`Invalid text-scan prompt key: ${key}`);
  await assertActiveModerator(createdById);
  const row = await dbWrite.textScanPrompt.create({
    data: { key, content, note, createdById },
    select: { id: true, key: true },
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

export function composeUserMessage(subject: TextScanSubject, maxInputChars: number) {
  return subject.fields
    .filter((field) => field.text?.trim())
    .map((field) => `## ${field.heading}\n${field.text!.trim()}`)
    .join('\n\n')
    .slice(0, maxInputChars);
}

export function composeTextScanMessages({
  prompts,
  labels,
  subject,
  maxInputChars,
}: {
  prompts: Record<string, ActiveTextScanPrompt>;
  labels: TextScanLabel[];
  subject: TextScanSubject;
  maxInputChars: number;
}) {
  const keys = ['base', ...labels.map((label) => `label:${label}`)];
  const missing = keys.filter((key) => !prompts[key]);
  if (missing.length) throw new MissingTextScanPromptError(missing);

  const system = [
    prompts.base.content,
    ...labels.map((label) => `## Label: ${label}\n${prompts[`label:${label}`].content}`),
  ].join('\n\n');

  const promptIds: PromptIds = { base: prompts.base.id };
  for (const label of labels) promptIds[label] = prompts[`label:${label}`].id;

  return { system, user: composeUserMessage(subject, maxInputChars), promptIds };
}

/** Uncapped and prompt-independent, unlike the dedup hash: appeal and re-file gates compare it. */
export function textScanTextHash(subject: TextScanSubject) {
  return hashContent(composeUserMessage(subject, Number.MAX_SAFE_INTEGER));
}
