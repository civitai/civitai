import * as z from 'zod';

export const TEXT_SCAN_E2E_PHASES = ['shadow', 'active', 'calibrate'] as const;
export type TextScanE2ePhase = (typeof TEXT_SCAN_E2E_PHASES)[number];

export const TEXT_SCAN_ENTITY_TYPES = [
  'Model',
  'Article',
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
  'User',
  'UserProfile',
] as const;

const e2eEnvSchema = z.object({
  TEXT_SCAN_E2E_PHASE: z.enum(TEXT_SCAN_E2E_PHASES),
  TEXT_SCAN_E2E_BASE_URL: z.url(),
  TEXT_SCAN_E2E_MODERATOR_URL: z.url(),
  TEXT_SCAN_E2E_HUB_URL: z.url(),
  TEXT_SCAN_E2E_DB_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  TEXT_SCAN_E2E_CALLBACK_ORIGIN: z.url(),
  WEBHOOK_TOKEN: z.string().min(1),
  AUTH_INTERNAL_TOKEN: z.string().min(1),
});

export type E2eEnv = z.infer<typeof e2eEnvSchema>;

/** The file wins over the shell for every key except the phase, which only the command line may set. */
export function parseE2eEnv(
  processEnv: Record<string, string | undefined>,
  fileVars: Record<string, string>,
  fileName: string
): E2eEnv {
  if ('TEXT_SCAN_E2E_PHASE' in fileVars)
    throw new Error(`${fileName} must not set TEXT_SCAN_E2E_PHASE; pass it on the command line`);
  const parsed = e2eEnvSchema.safeParse({
    ...processEnv,
    ...fileVars,
    TEXT_SCAN_E2E_PHASE: processEnv.TEXT_SCAN_E2E_PHASE,
  });
  if (!parsed.success)
    throw new Error(
      `text-scan e2e env invalid (${fileName} + command line): ${z.prettifyError(parsed.error)}`
    );
  return parsed.data;
}

/** Postgres `timestamp without time zone` text, read as UTC — the zone Prisma writes in. */
export function parseUtcTimestamp(value: string): Date {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`unparseable timestamp: ${value}`);
  return date;
}

export function clockSkewError(dbNow: Date, localNowMs: number, toleranceMs: number) {
  const skew = localNowMs - dbNow.getTime();
  return Math.abs(skew) > toleranceMs
    ? `this machine's clock is ${skew}ms off the DB clock (tolerance ${toleranceMs}ms). The app stamps updatedAt with this clock and freshness compares it with the DB clock.`
    : null;
}

export function devDbFingerprintError(newestUserAgeSeconds: number | null, minAgeSeconds: number) {
  if (newestUserAgeSeconds === null) return 'the DB has no User rows outside the e2e range';
  return newestUserAgeSeconds < minAgeSeconds
    ? `the newest User is ${Math.round(
        newestUserAgeSeconds
      )}s old: this DB is taking live signups, so it is not the dev clone. Refusing to write to it.`
    : null;
}

export function jobRunError(name: string, status: number, body: unknown): string | null {
  const b = (body ?? {}) as { ok?: unknown; error?: unknown };
  const detail = JSON.stringify(body ?? null).slice(0, 600);
  if (status === 404) return `job ${name} is not registered in run-jobs`;
  if (status < 200 || status >= 300) return `job ${name} -> HTTP ${status}: ${detail}`;
  if (b.ok !== true) return `job ${name} failed: ${detail}`;
  if (b.error) return `job ${name} did not run: ${String(b.error)}`;
  return null;
}

export function modeMismatches(
  modes: Record<string, unknown>,
  expected: 'shadow' | 'active',
  entityTypes: readonly string[] = TEXT_SCAN_ENTITY_TYPES
) {
  return entityTypes
    .filter((type) => modes[type] !== expected)
    .map((type) => `${type}=${String(modes[type] ?? 'missing')}`);
}

export type ScanRowLike = {
  status: string;
  workflowId: string | null;
  result: { version?: number } | null;
};

export type ScanRowState = 'done' | 'pending' | 'failed';

/** `row` is the EM row already filtered to `updatedAt > since` in SQL, or undefined. */
export function classifyScanRow(
  row: ScanRowLike | undefined,
  afterWorkflowId?: string | null
): ScanRowState {
  if (!row) return 'pending';
  if (afterWorkflowId !== undefined && row.workflowId === afterWorkflowId) return 'pending';
  if (row.status === 'Succeeded') return row.result?.version === 1 ? 'done' : 'pending';
  return row.status === 'Pending' ? 'pending' : 'failed';
}

export function observedPhase(fresh: { live?: ScanRowLike; shadow?: ScanRowLike }) {
  if (classifyScanRow(fresh.shadow) === 'done') return 'shadow' as const;
  if (classifyScanRow(fresh.live) === 'done') return 'active' as const;
  return null;
}
