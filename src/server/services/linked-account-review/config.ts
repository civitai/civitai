import * as z from 'zod';

const positive = z.number().positive();
const share = z.number().gt(0).lte(1);

export const linkedAccountReviewConfig = z.object({
  mode: z.enum(['dry-run', 'file']),
  flowDays: positive,
  linkDays: positive,
  stickerPairMin: positive,
  buzzSenderMin: positive,
  buzzEdgeShare: share,
  buzzAccountTypes: z.array(z.string().regex(/^[a-z]+$/)).min(1),
  ipAccountCap: positive,
  minSharedIps: positive,
  share,
  stickerFloor: positive,
  buzzFloor: positive,
  refileDays: positive,
  controlUserIds: z
    .array(z.number().int().positive())
    .default([])
    .transform((ids) => [...new Set(ids)]),
});
export type LinkedAccountReviewConfig = z.infer<typeof linkedAccountReviewConfig>;

export type ConfigResult =
  | { ok: true; config: LinkedAccountReviewConfig }
  | { ok: false; error: string };

export function parseConfig(raw: string | null | undefined): ConfigResult {
  if (!raw) return { ok: false, error: 'config is not set' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'config is not valid JSON' };
  }
  const parsed = linkedAccountReviewConfig.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, config: parsed.data };
}
