import type { ImageScanningJointAgeDetection } from '@civitai/orchestration-client';
import { env } from '~/env/server';
import { SEARCH_UPLOAD_FACE_SCAN_META_KEY } from '~/shared/utils/block-provenance-metadata';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/** The scan gate for search by uploaded image: whether an uploaded row may be embedded and searched from. */

/** What the scan wrote on the row before its verdict. */
export type SearchUploadFaceScan = { ran: boolean; faces: { animeProbability: number | null }[] };

export function toSearchUploadFaceScan(scan: {
  ageClassificationRan: boolean;
  ageDetections: Pick<ImageScanningJointAgeDetection, 'animeProbability'>[];
}): SearchUploadFaceScan {
  return {
    ran: scan.ageClassificationRan,
    faces: scan.ageDetections.map(({ animeProbability }) => ({
      animeProbability: Number.isFinite(animeProbability) ? animeProbability : null,
    })),
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

export type SearchUploadRow = {
  ingestion: ImageIngestionStatus | string;
  tosViolation: boolean;
  blockedFor: string | null;
  needsReview: string | null;
  minor: boolean;
  poi: boolean;
  metadata: unknown;
};

export type SearchUploadBlobState =
  | { verdict: 'pending' }
  | { verdict: 'rated'; blockedReason: string | null };

export type SearchUploadVerdict = 'pending' | 'ready' | 'refused';

const PENDING_INGESTION: string[] = [ImageIngestionStatus.Pending, ImageIngestionStatus.Rescan];

/** The same row conditions an indexed image must meet (event-engine `vector-sync/eligibility.ts`), less the post. */
export function searchUploadVerdict(
  row: SearchUploadRow,
  blob: SearchUploadBlobState,
  { isModerator, faceAnimeMin }: { isModerator: boolean; faceAnimeMin: number | undefined }
): SearchUploadVerdict {
  if (PENDING_INGESTION.includes(row.ingestion)) return 'pending';
  if (
    row.ingestion !== ImageIngestionStatus.Scanned ||
    row.tosViolation ||
    row.blockedFor !== null ||
    row.needsReview !== null ||
    row.minor ||
    row.poi
  )
    return 'refused';
  if (blob.verdict === 'pending') return 'pending';
  if (blob.blockedReason) return 'refused';
  if (isModerator) return 'ready';
  const faceScan = (row.metadata as Record<string, unknown> | null)?.[
    SEARCH_UPLOAD_FACE_SCAN_META_KEY
  ];
  return faceScanAllows(faceScan, faceAnimeMin) ? 'ready' : 'refused';
}
