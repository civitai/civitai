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

export type RunPlanInput = {
  seed: number;
  core: readonly number[];
  /** Fresh items the player has not met in an earlier run. */
  freshUnseen: readonly number[];
  freshSeen: readonly number[];
  length: number;
  freshCount: number;
};

/** Core items first, then fresh ones. Same input, same plan. */
export function planRun({ seed, core, freshUnseen, freshSeen, length, freshCount }: RunPlanInput) {
  const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);
  const fresh = [
    ...seededShuffle(sorted(freshUnseen), seed ^ 0x51ed),
    ...seededShuffle(sorted(freshSeen), seed ^ 0x2f1d),
  ].slice(0, freshCount);
  const coreSlots = Math.max(0, length - fresh.length);
  return {
    core: seededShuffle(sorted(core), seed).slice(0, coreSlots),
    fresh,
  };
}

export type ScoredAnswer = { fresh: boolean; correct: boolean };

/** Only fresh items count: the core set teaches. */
export function scoreRun(answers: readonly ScoredAnswer[], passMark: number) {
  const fresh = answers.filter((a) => a.fresh);
  if (fresh.length === 0) return { score: 0, passed: false };
  const score = fresh.filter((a) => a.correct).length / fresh.length;
  return { score, passed: score >= passMark };
}

/** Stable per image, so an image never changes pool between harvests. */
export function poolFor(imageId: number, hiddenCheckShare: number): 'trials' | 'hiddenCheck' {
  const hash = Math.imul(imageId ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return hash / 4294967296 < hiddenCheckShare ? 'hiddenCheck' : 'trials';
}
