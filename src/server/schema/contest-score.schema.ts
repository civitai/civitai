import * as z from 'zod';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

export const contestScoreSignals = [
  'imageAuthors',
  'reactors',
  'downloaders',
  'generators',
  'collectors',
] as const;
export type ContestScoreSignal = (typeof contestScoreSignals)[number];

const windowShape = {
  collectionId: z.number().int().positive(),
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
  tagIds: z.array(z.number().int().positive()).max(50).optional(),
  statuses: z.array(z.enum(CollectionItemStatus)).min(1).max(3).optional(),
};

const orderedWindow = (data: { start?: Date; end?: Date }) =>
  !data.start || !data.end || data.start < data.end;
const orderedWindowError = { message: 'start must precede end', path: ['end'] };

export type GetCommunityScoreInput = z.infer<typeof getCommunityScoreSchema>;
export const getCommunityScoreSchema = z
  .object(windowShape)
  .refine(orderedWindow, orderedWindowError);

export type RunCommunityScoreInput = z.infer<typeof runCommunityScoreSchema>;
export const runCommunityScoreSchema = getCommunityScoreSchema;

export type GetContestCandidatesInput = z.infer<typeof getContestCandidatesSchema>;
export const getContestCandidatesSchema = z
  .object({ ...windowShape, limit: z.number().int().positive().max(1000).optional() })
  .refine(orderedWindow, orderedWindowError);

export type CreateContestSnapshotInput = z.infer<typeof createContestSnapshotSchema>;
export const createContestSnapshotSchema = z
  .object({ ...windowShape, note: z.string().max(500).optional() })
  .refine(orderedWindow, orderedWindowError);

export type ListContestSnapshotsInput = z.infer<typeof listContestSnapshotsSchema>;
export const listContestSnapshotsSchema = z.object({
  collectionId: z.number().int().positive(),
});

export type GetContestSnapshotInput = z.infer<typeof getContestSnapshotSchema>;
export const getContestSnapshotSchema = z.object({
  collectionId: z.number().int().positive(),
  key: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Structural validation only, and deliberately so: a min/max on a weight or a
 * threshold would publish that value's range to anyone who can read this file, and
 * this repo mirrors publicly. Magnitudes are constrained by review, not by zod.
 */
const weightsSchema = z.object(
  Object.fromEntries(contestScoreSignals.map((s) => [s, z.number()])) as Record<
    ContestScoreSignal,
    z.ZodNumber
  >
);

/** The editable surface. `version` and provenance are set by the server, never by a client. */
export type ContestScoringConfigValues = z.infer<typeof contestScoringConfigValuesSchema>;
export const contestScoringConfigValuesSchema = z.object({
  weights: weightsSchema,
  ageGateDays: z.number(),
  // Floor on each signal's normalization denominator. Where a category's leading
  // qualified count is tiny, plain max-normalization lets one or two users swing a
  // signal from 0 to 0.5 and decide a placement on noise.
  minDenominator: weightsSchema,
  // Ceiling on the engager set resolved against Postgres. Past it the banned/deleted
  // refinement is skipped and the run is flagged degraded rather than run anyway.
  maxEngagers: z.number(),
  farmIp: z.object({ minPeers: z.number(), minEntries: z.number() }),
});

export type ContestScoringConfig = z.infer<typeof contestScoringConfigSchema>;
export const contestScoringConfigSchema = contestScoringConfigValuesSchema.extend({
  version: z.number(),
  updatedById: z.number().optional(),
  updatedByUsername: z.string().nullish(),
  updatedAt: z.string().optional(),
});

/**
 * Which KeyValue row an edit lands on. `global` rewrites the fallback every future
 * contest reads, so the client must choose it explicitly — there is no default that
 * quietly means "all contests".
 */
export const contestScoringScopes = ['collection', 'global'] as const;
export type ContestScoringScope = (typeof contestScoringScopes)[number];

export type GetContestScoringConfigInput = z.infer<typeof getContestScoringConfigSchema>;
export const getContestScoringConfigSchema = z.object({
  collectionId: z.number().int().positive(),
});

export type SetContestScoringConfigInput = z.infer<typeof setContestScoringConfigSchema>;
export const setContestScoringConfigSchema = z.object({
  collectionId: z.number().int().positive(),
  scope: z.enum(contestScoringScopes),
  config: contestScoringConfigValuesSchema,
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const contestScoreRunStatuses = ['queued', 'running', 'done', 'failed'] as const;
export type ContestScoreRunStatus = (typeof contestScoreRunStatuses)[number];

/**
 * Pushed to `SignalTopic.ContestScore:<collectionId>` on every state change and also
 * returned by the read query. It carries run bookkeeping ONLY — no scores, no config.
 * A topic is joinable by any connected client, so nothing on this payload may be
 * something the moderator gate exists to protect.
 */
export type ContestScoreRunState = {
  runId: string;
  collectionId: number;
  status: ContestScoreRunStatus;
  requestedBy: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** `generatedAt` of the result this run produced; the client uses it to tell runs apart. */
  generatedAt: string | null;
};
