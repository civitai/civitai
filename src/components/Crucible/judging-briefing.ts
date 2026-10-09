type BriefingStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const briefingKey = (crucibleId: number) => `crucible-judge-briefing:${crucibleId}`;

export function hasSeenBriefing(crucibleId: number, storage: BriefingStorage | undefined) {
  try {
    return !!storage?.getItem(briefingKey(crucibleId));
  } catch {
    return false;
  }
}

export function markBriefingSeen(crucibleId: number, storage: BriefingStorage | undefined) {
  try {
    storage?.setItem(briefingKey(crucibleId), '1');
  } catch {
    // Private mode or blocked storage: the briefing just shows again next visit.
  }
}
