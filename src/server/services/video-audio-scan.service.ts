import { getWorkflow } from '@civitai/orchestration-client';
import type {
  Priority,
  WorkflowStepTemplate,
  WorkflowTemplate,
} from '@civitai/orchestration-client';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { buildAudioModerationStep } from '~/server/services/audio-scan/song-scan';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { submitWorkflowWithRetry } from '~/server/services/orchestrator/workflows';

const LOG_NAME = 'video-audio-scan';
// A transcript of a long video can be large; nothing reads it whole.
const MAX_STORED_LYRICS = 20_000;
const SUBMIT_ATTEMPT_TIMEOUT_MS = 15_000;
export const AUDIO_SCAN_RESULT_VERSION = 1;

export function audioScanCallbackUrl() {
  return `${env.NEXTAUTH_URL}/api/webhooks/audio-scan-result?token=${env.WEBHOOK_TOKEN}`;
}

/**
 * Submits one audio scan workflow and records it as the image's pending scan. A re-ingested image
 * starts over: the older workflow's callback no longer matches.
 */
async function submitAudioScanWorkflow({
  imageId,
  steps,
  metadata,
}: {
  imageId: number;
  steps: WorkflowStepTemplate[];
  metadata: Record<string, unknown>;
}) {
  const body: WorkflowTemplate = {
    externalId: randomUUID(),
    metadata,
    currencies: [],
    steps,
    callbacks: [
      {
        url: audioScanCallbackUrl(),
        type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
      },
    ],
  };
  const submitted = await submitWorkflowWithRetry(
    { client: internalOrchestratorClient, body },
    { perAttemptTimeoutMs: SUBMIT_ATTEMPT_TIMEOUT_MS }
  );
  const result = { ...submitted, body };
  const { data } = result;
  if (!data?.id) return result;

  const pending = {
    workflowId: data.id,
    status: 'Pending',
    flagged: null,
    hasAudio: null,
    resultVersion: null,
    error: null,
    createdAt: new Date(),
    completedAt: null,
  };
  await dbWrite.imageAudioScan.upsert({
    where: { imageId },
    create: { imageId, ...pending },
    update: { ...pending, result: Prisma.DbNull },
  });
  return result;
}

/**
 * Submits a shadow audio scan for a video as its own workflow, so an audio failure cannot touch the
 * visual scan. Never throws: a failed submit is logged and the video simply has no audio result.
 */
export async function submitVideoAudioScan({
  imageId,
  mediaUrl,
  priority,
}: {
  imageId: number;
  mediaUrl: string;
  priority?: Priority;
}) {
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.VIDEO_AUDIO_SCAN, String(imageId)))) return;

    const metadata = { imageId, scan: 'audio' };
    const { data, response } = await submitAudioScanWorkflow({
      imageId,
      metadata,
      steps: [buildAudioModerationStep({ mediaUrl, metadata, priority })],
    });
    if (!data?.id)
      throw new Error(`audio scan submit failed (${response?.status ?? 'no response'})`);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: LOG_NAME,
      message: 'audio scan submit failed',
      imageId,
      error: safeError(error),
    }).catch(() => null);
  }
}

/**
 * Submits the scan that decides a song's ingestion. Unlike the video scan this is not behind a flag
 * and does not swallow failure: the caller owns what an unsubmitted song becomes, so it gets the
 * submit result as it would from the image scan.
 */
type StandingAudioScan = {
  data: { id: string };
  attempts: number;
  body?: undefined;
  response?: undefined;
};

export async function submitSongScan({
  imageId,
  mediaUrl,
  priority,
}: {
  imageId: number;
  mediaUrl: string;
  priority?: Priority;
}) {
  const audio = await dbWrite.imageAudioScan.findUnique({
    where: { imageId },
    select: { status: true, workflowId: true },
  });
  if (audio?.status === 'Succeeded') {
    // At the call site: track-lyrics reaches back here through the orchestrator service.
    const { readLyricsVerdict, sendTrackLyricsScan } = await import(
      '~/server/services/audio-scan/track-lyrics'
    );
    const lyrics = await readLyricsVerdict(imageId);
    if (lyrics.state === 'pending') {
      // A send with no verdict coming throws, so the caller counts it toward the retry cap.
      if (!lyrics.inFlight) await sendTrackLyricsScan(imageId);
      // The stored audio workflow stands in for a submit, so the caller stamps the attempt.
      return { data: { id: audio.workflowId }, attempts: 0 } satisfies StandingAudioScan;
    }
  }

  const metadata = { imageId, scan: 'song' };
  return submitAudioScanWorkflow({
    imageId,
    metadata,
    steps: [buildAudioModerationStep({ mediaUrl, metadata, priority })],
  });
}

const scannedAudio = z
  .object({
    lyrics: z.string(),
    sexualizedMinors: z.boolean(),
    blocked: z.boolean(),
    score: z.number().finite(),
    model: z.string().min(1).max(500),
    policyHash: z.string().min(1).max(500),
    hasAudio: z.literal(true).nullish(),
    skippedReason: z.null().optional(),
  })
  .strict();

const noAudio = z
  .object({
    lyrics: z.literal(''),
    sexualizedMinors: z.literal(false),
    blocked: z.literal(false),
    score: z.null().optional(),
    model: z.null().optional(),
    policyHash: z.null().optional(),
    hasAudio: z.literal(false),
    skippedReason: z.string().min(1).max(500),
  })
  .strict();

/** Version 1 of the audioModeration output. A shape it does not know is an error, never a pass. */
const audioScanOutputV1 = z.union([scannedAudio, noAudio]);

type RawStep = { $type?: string; status?: string; output?: unknown };

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export type AudioScanParse =
  | {
      ok: true;
      flagged: boolean | null;
      hasAudio: boolean;
      result: z.infer<typeof audioScanOutputV1>;
    }
  | { ok: false; error: string; failureType?: string };

/** The verdict of the `audioModeration` step, from its own status and output. */
export function parseAudioScanSteps(steps: unknown[]): AudioScanParse {
  const step = (steps as RawStep[]).find((candidate) => candidate.$type === 'audioModeration');
  // A workflow with another step that failed is itself `failed`; this step's own status decides.
  if (step?.status && step.status !== 'succeeded')
    return { ok: false, error: `audio moderation step ${step.status}` };
  const output = step?.output;
  if (!output) return { ok: false, error: 'missing audio moderation output' };

  const parsed = audioScanOutputV1.safeParse(output);
  if (!parsed.success)
    return { ok: false, error: `unrecognised audio scan output: ${parsed.error.message}` };

  const result = parsed.data;
  if (result.hasAudio === false) return { ok: true, flagged: null, hasAudio: false, result };
  if (result.blocked !== result.sexualizedMinors)
    return { ok: false, error: 'inconsistent audio scan verdict' };
  return { ok: true, flagged: result.sexualizedMinors, hasAudio: true, result };
}

export type SongScanResult = {
  imageId: number;
  workflowId: string;
  steps: unknown[];
  parsed: AudioScanParse;
};

/**
 * Stores the result for an audio scan callback. The posted workflowId must match a pending row before
 * anything is fetched, so the route cannot be used to make us read arbitrary workflows; the verdict is
 * then read from the orchestrator, never from the posted body.
 *
 * A video's verdict stays on the scan row. A song's is handed back as `song`, once, for its ingestion
 * to be decided.
 */
export async function processAudioScanCallback(
  workflowId: unknown
): Promise<{ stored: boolean; reason: string; song?: SongScanResult }> {
  if (typeof workflowId !== 'string' || !workflowId)
    return { stored: false, reason: 'no-workflow' };

  const row = await dbWrite.imageAudioScan.findFirst({
    where: { workflowId, status: 'Pending' },
    select: { imageId: true },
  });
  if (!row) return { stored: false, reason: 'unknown-workflow' };

  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${workflowId}`);
  if (data.metadata?.imageId !== row.imageId)
    return finish(workflowId, { ok: false, error: 'workflow metadata does not match the image' });
  // The callback can land before the read-back settles; throwing has the orchestrator retry.
  if (!data.status || !TERMINAL_STATUSES.has(data.status))
    throw new Error(`workflow ${workflowId} not finished: ${data.status ?? 'unknown'}`);

  const steps = data.steps ?? [];
  const image = await dbWrite.image.findUnique({
    where: { id: row.imageId },
    select: { type: true },
  });
  const isSong = image?.type === 'audio';

  const workflowFailure: AudioScanParse = {
    ok: false,
    error: `workflow ${data.status}`,
    failureType:
      data.status === 'expired'
        ? 'expired'
        : data.status === 'canceled'
        ? 'canceled'
        : 'workflow-failed',
  };
  const parsed = data.status === 'succeeded' ? parseAudioScanSteps(steps) : workflowFailure;
  const result = await finish(workflowId, parsed);

  if (!result.stored || !isSong) return result;
  return { ...result, song: { imageId: row.imageId, workflowId, steps, parsed } };
}

async function finish(workflowId: string, parsed: AudioScanParse) {
  const completedAt = new Date();
  // Conditional on Pending, so a duplicate callback cannot rewrite a stored result.
  const { count } = await dbWrite.imageAudioScan.updateMany({
    where: { workflowId, status: 'Pending' },
    data: parsed.ok
      ? {
          status: 'Succeeded',
          flagged: parsed.flagged,
          hasAudio: parsed.hasAudio,
          result: { ...parsed.result, lyrics: parsed.result.lyrics.slice(0, MAX_STORED_LYRICS) },
          resultVersion: AUDIO_SCAN_RESULT_VERSION,
          completedAt,
        }
      : { status: 'Failed', error: parsed.error.slice(0, 1000), completedAt },
  });
  if (!parsed.ok)
    logToAxiom({ type: 'warning', name: LOG_NAME, message: parsed.error, workflowId }).catch(
      () => null
    );
  return { stored: count > 0, reason: parsed.ok ? 'succeeded' : 'failed' };
}
