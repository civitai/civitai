/**
 * Text state for the A4 "image + scanner signals" and "signals only" arms, built from a re-scan's
 * `ImageScanningOutput`.
 *
 * Built field by field from an allowlist, never by spreading or deleting from the scan output. The
 * scanner's CSAM verdict must never reach a decision model, and a denylist would silently start
 * forwarding whatever field the orchestrator adds next.
 *
 * Structural types rather than the orchestration client's, so this module carries no dependency and
 * a field the client renames fails to compile here instead of disappearing.
 */

type LabelScore = { label: string; score: number };

export type ScanOutputInput = {
  nsfwLevel: string;
  aiRecognition?: LabelScore | null;
  animeRecognition?: LabelScore | null;
  tagging?: { tags: { tag: string; category: string; score: number }[] } | null;
  humanRecognition?: { ran: boolean; label: string; score: number } | null;
  jointAgeClassification?: {
    ran: boolean;
    detections: {
      boundingBox: number[];
      faceBoundingBox?: number[] | null;
      domain: string;
      animeProbability: number;
      apparentAge?: number | null;
      ageBand?: string | null;
      under18Probability?: number | null;
      isMinor: boolean;
      isOod: boolean;
    }[];
    childDetected?: boolean | null;
    minorDetected?: boolean | null;
    oodDetected?: boolean | null;
  } | null;
};

export type SignalState = {
  rating: string;
  tags: { tag: string; score: number }[];
  style: { ai: LabelScore | null; anime: LabelScore | null };
  human: LabelScore | null;
  age: {
    detections: {
      box: number[] | null;
      faceBox: number[] | null;
      domain: string;
      animeProbability: number;
      apparentAge: number | null;
      ageBand: string | null;
      under18Probability: number | null;
      isMinor: boolean;
      isOod: boolean;
    }[];
    minorDetected: boolean | null;
    childDetected: boolean | null;
    oodDetected: boolean | null;
  } | null;
};

const MAX_TAGS = 40;

const round2 = (n: number) => Math.round(n * 100) / 100;

function relativeBox(box: number[] | null | undefined, size?: { width: number; height: number }) {
  if (!box || box.length !== 4 || !size?.width || !size?.height) return null;
  const [x1, y1, x2, y2] = box;
  return [x1 / size.width, y1 / size.height, x2 / size.width, y2 / size.height].map(round2);
}

const labelScore = (r: LabelScore | null | undefined): LabelScore | null =>
  r?.label ? { label: r.label, score: round2(r.score) } : null;

export function buildSignalState(
  scan: ScanOutputInput,
  imageSize?: { width: number; height: number }
): SignalState {
  const tags = (scan.tagging?.tags ?? [])
    .filter((t) => t.category === 'general')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TAGS)
    .map((t) => ({ tag: t.tag, score: round2(t.score) }));

  const age = scan.jointAgeClassification?.ran
    ? {
        detections: scan.jointAgeClassification.detections.map((d) => ({
          box: relativeBox(d.boundingBox, imageSize),
          faceBox: relativeBox(d.faceBoundingBox, imageSize),
          domain: d.domain,
          animeProbability: round2(d.animeProbability),
          apparentAge: d.apparentAge ?? null,
          ageBand: d.ageBand ?? null,
          under18Probability: d.under18Probability == null ? null : round2(d.under18Probability),
          isMinor: d.isMinor,
          isOod: d.isOod,
        })),
        minorDetected: scan.jointAgeClassification.minorDetected ?? null,
        childDetected: scan.jointAgeClassification.childDetected ?? null,
        oodDetected: scan.jointAgeClassification.oodDetected ?? null,
      }
    : null;

  return {
    rating: scan.nsfwLevel,
    tags,
    style: { ai: labelScore(scan.aiRecognition), anime: labelScore(scan.animeRecognition) },
    human: scan.humanRecognition?.ran ? labelScore(scan.humanRecognition) : null,
    age,
  };
}
