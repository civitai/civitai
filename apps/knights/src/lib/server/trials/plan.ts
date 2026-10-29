export type PlannedItem = { id: number };

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A stored run replays its plan from `seed`. Core items shuffle with the seed itself and fresh ones
 * with the seed xor this salt, so changing either reorders every plan stored by an open run.
 */
const FRESH_SEED_SALT = 0x51ed;

export type RunPlanInput = {
  seed: number;
  core: readonly number[];
  /** Fresh items this player has not answered. */
  freshUnseen: readonly number[];
  length: number;
  freshCount: number;
};

export function planRun({ seed, core, freshUnseen, length, freshCount }: RunPlanInput) {
  const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);
  const fresh = seededShuffle(sorted(freshUnseen), seed ^ FRESH_SEED_SALT).slice(0, freshCount);
  const coreSlots = Math.max(0, length - fresh.length);
  return {
    core: seededShuffle(sorted(core), seed).slice(0, coreSlots),
    fresh,
  };
}

/** `fresh` is false for core items: the core set teaches and is not scored. */
export type ScoredAnswer = { fresh: boolean; correct: boolean };

export type RunScore =
  | { result: 'void'; score: null }
  | { result: 'passed' | 'failed'; score: number };

export function scoreRun(
  answers: readonly ScoredAnswer[],
  { passMark, minFresh }: { passMark: number; minFresh: number }
): RunScore {
  const fresh = answers.filter((a) => a.fresh);
  if (fresh.length < Math.max(1, minFresh)) return { result: 'void', score: null };
  const score = fresh.filter((a) => a.correct).length / fresh.length;
  return { result: score >= passMark ? 'passed' : 'failed', score };
}

/** Stable per image, so an image never changes pool between harvests. */
export function poolFor(imageId: number, hiddenCheckShare: number): 'trials' | 'hiddenCheck' {
  const hash = Math.imul(imageId ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return hash / 4294967296 < hiddenCheckShare ? 'hiddenCheck' : 'trials';
}
