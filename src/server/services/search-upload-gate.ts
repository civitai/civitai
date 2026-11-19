import type { ImageScanningOutput } from '@civitai/orchestration-client';
import { env } from '~/env/server';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';

/** The scan gate for search by uploaded image: whether an uploaded blob may be embedded and searched from. */

/** The faces the scan found, as the face rule reads them. */
export type SearchUploadFaceScan = { ran: boolean; faces: { animeProbability: number | null }[] };

/** The imageScanning workflow on the blob, as the gate reads it. */
export type SearchUploadScan =
  | { state: 'pending' }
  | { state: 'failed' }
  | {
      state: 'done';
      /** When the scan step finished, as the orchestrator reports it. */
      completedAt?: string | null;
      nsfwLevel: number;
      blocked: boolean;
      minorDetected: boolean;
      childDetected: boolean;
      faceScan: SearchUploadFaceScan;
    };

const FAILED_STATUSES = new Set(['failed', 'expired', 'canceled']);

// The client package predates these fields.
type ScanOutput = Partial<ImageScanningOutput> & {
  blockedReason?: string | null;
  csam?: boolean | null;
};

/** Pending until the workflow ends; a succeeded workflow without a usable scan reads as failed. */
export function readSearchUploadScan(workflow: {
  status?: string | null;
  steps?: unknown[] | null;
}): SearchUploadScan {
  const status = workflow.status ?? '';
  if (FAILED_STATUSES.has(status)) return { state: 'failed' };
  if (status !== 'succeeded') return { state: 'pending' };

  const step = (workflow.steps ?? []).find(
    (s) => (s as { $type?: string } | null)?.$type === 'imageScanning'
  ) as { output?: ScanOutput; completedAt?: string | null } | undefined;
  const output = step?.output;
  const nsfwLevel = output?.nsfwLevel ? orchestratorNsfwLevelMap[output.nsfwLevel] : undefined;
  const age = output?.jointAgeClassification;
  if (!output || nsfwLevel === undefined || age?.ran !== true) return { state: 'failed' };

  return {
    state: 'done',
    completedAt: step?.completedAt ?? null,
    nsfwLevel,
    blocked: !!output.blockedReason || output.csam === true,
    minorDetected: !!age.minorDetected,
    childDetected: !!age.childDetected,
    faceScan: {
      ran: age.ran === true,
      faces: (age.detections ?? []).map(({ animeProbability }) => ({
        animeProbability: Number.isFinite(animeProbability) ? animeProbability : null,
      })),
    },
  };
}

/** The configured minimum, or undefined when unset or invalid. */
export function parseFaceAnimeMin(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export const searchUploadFaceAnimeMin = () => parseFaceAnimeMin(env.SEARCH_UPLOAD_FACE_ANIME_MIN);

export function faceScanAllows(faceScan: unknown, minAnime: number | undefined): boolean {
  if (!faceScan || typeof faceScan !== 'object') return false;
  const { ran, faces } = faceScan as Partial<SearchUploadFaceScan>;
  if (ran !== true || !Array.isArray(faces)) return false;
  if (faces.length === 0) return true;
  if (minAnime === undefined) return false;
  return faces.every(
    (face) =>
      typeof face?.animeProbability === 'number' &&
      Number.isFinite(face.animeProbability) &&
      face.animeProbability >= minAnime
  );
}

export type SearchUploadBlobState =
  | { verdict: 'pending' }
  | { verdict: 'rated'; blockedReason: string | null };

export type SearchUploadVerdict = 'pending' | 'ready' | 'refused';
/** Why an upload was refused: logged with ids only, never told to the uploader. */
export type SearchUploadRefusal =
  | 'scan-failed'
  | 'timed-out'
  | 'blocked'
  | 'minor'
  | 'blob-blocked'
  | 'faces';
export type SearchUploadDecision =
  | { verdict: 'pending' | 'ready' }
  | { verdict: 'refused'; reason: SearchUploadRefusal };

/**
 * Refused on any block, minor or child flag, for moderators too: their only bypass is the face
 * rule. Still waiting once `timedOut` is refused, so a scan that never answers never passes.
 */
export function searchUploadVerdict(
  scan: SearchUploadScan,
  blob: SearchUploadBlobState,
  {
    isModerator,
    faceAnimeMin,
    timedOut,
  }: { isModerator: boolean; faceAnimeMin: number | undefined; timedOut: boolean }
): SearchUploadDecision {
  const refuse = (reason: SearchUploadRefusal) => ({ verdict: 'refused' as const, reason });
  const waiting = timedOut ? refuse('timed-out') : { verdict: 'pending' as const };
  if (scan.state === 'failed') return refuse('scan-failed');
  if (scan.state === 'pending') return waiting;
  if (scan.blocked) return refuse('blocked');
  if (scan.minorDetected || scan.childDetected) return refuse('minor');
  if (blob.verdict === 'pending') return waiting;
  if (blob.blockedReason) return refuse('blob-blocked');
  if (isModerator) return { verdict: 'ready' };
  return faceScanAllows(scan.faceScan, faceAnimeMin) ? { verdict: 'ready' } : refuse('faces');
}
