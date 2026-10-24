import * as z from 'zod';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

/**
 * Runtime knobs for the Hugging Face transfer, so the shape of a running import can be changed
 * without a deploy. Before this existed the only lever on a transfer hurting production was shipping
 * a new constant.
 *
 * 🔴 The bounds are the point, not the defaults. `partsInFlight × filesInParallel × PART_SIZE_BYTES`
 * is the RETAINED payload — 3 × 2 × 16MB = 96MB at the defaults — but measured RSS growth is ~200MB,
 * because `res.arrayBuffer()` leaves undici's concat buffer alive and that garbage is off-heap, where
 * it barely pressures V8's major-GC trigger. It oscillates rather than leaks, but a container limit is
 * a hard limit, so size headroom against the larger number. An unbounded value here would be an OOM on
 * a web pod set from a text box; the bounds live here rather than in the UI because the UI is not the
 * only caller.
 */
export const huggingFaceImportConfigSchema = z.object({
  /** The kill switch. Off leaves queued rows untouched; it stops claiming new work. */
  enabled: z.boolean(),
  /** Files transferred at once across the whole fleet — one job run holds the lock. */
  filesInParallel: z.number().int().min(1).max(4),
  /** Parts of one file in flight at once. */
  partsInFlight: z.number().int().min(1).max(6),
  /** How long one run transfers before yielding. Must stay well inside the job's 5-minute lock. */
  workBudgetSeconds: z.number().int().min(15).max(240),
});

export type HuggingFaceImportConfig = z.infer<typeof huggingFaceImportConfigSchema>;

/**
 * Deliberately modest. 3 × 2 × 16MB is ~96MB retained and ~200MB resident, which a web pod can carry
 * while serving traffic; the budget leaves three minutes of the lock for the slowest part in flight.
 */
export const HUGGING_FACE_IMPORT_DEFAULTS: HuggingFaceImportConfig = {
  enabled: true,
  filesInParallel: 2,
  partsInFlight: 3,
  workBudgetSeconds: 120,
};

/**
 * 🔴 Fails OPEN to the defaults. A config store that cannot be read must not stop transfers, and must
 * not silently resolve concurrency to zero — both are worse than running at the shipped shape.
 */
export async function getHuggingFaceImportConfig(): Promise<HuggingFaceImportConfig> {
  let stored: Partial<HuggingFaceImportConfig> = {};
  try {
    const raw = await withSysReadDeadline(
      sysRedis.packed.get<Partial<HuggingFaceImportConfig>>(
        REDIS_SYS_KEYS.HUGGING_FACE_IMPORT.CONFIG
      )
    );
    if (raw) stored = huggingFaceImportConfigSchema.partial().parse(raw);
  } catch (error) {
    logSysRedisFailOpen('read-degraded', 'getHuggingFaceImportConfig', error);
  }

  return { ...HUGGING_FACE_IMPORT_DEFAULTS, ...stored };
}

/** Merges over what is stored, so a caller may set one knob without restating the rest. */
export async function setHuggingFaceImportConfig(input: Partial<HuggingFaceImportConfig>) {
  const next = huggingFaceImportConfigSchema.parse({
    ...(await getHuggingFaceImportConfig()),
    ...input,
  });
  await sysRedis.packed.set(REDIS_SYS_KEYS.HUGGING_FACE_IMPORT.CONFIG, next);
  return next;
}
