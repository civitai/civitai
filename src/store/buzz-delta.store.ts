import { useMemo } from 'react';
import { create } from 'zustand';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypes, buzzSpendTypes } from '~/shared/constants/buzz.constants';

export const BUZZ_DELTA_QUIET_MS = 700;
export const BUZZ_DELTA_BIG_HOLD_MS = 2200;
export const BUZZ_DELTA_BIG_AMOUNT = 10_000;

export type BuzzDeltaDirection = 'debit' | 'credit';
type BuzzDeltaKey = `${BuzzSpendType}:${BuzzDeltaDirection}`;

type OpenGroup = {
  type: BuzzSpendType;
  direction: BuzzDeltaDirection;
  /** Magnitude; the sign lives in `direction`. */
  total: number;
  count: number;
  /** A single update in the group reached `BUZZ_DELTA_BIG_AMOUNT`. */
  big: boolean;
};

export type SettledBuzzDelta = OpenGroup & { seq: number };

interface BuzzDeltaState {
  groups: Partial<Record<BuzzDeltaKey, OpenGroup>>;
  settled: SettledBuzzDelta | null;
  record: (type: BuzzSpendType, delta: number) => void;
  reset: () => void;
}

const timers = new Map<BuzzDeltaKey, ReturnType<typeof setTimeout>>();
const pending = new Map<
  BuzzDeltaKey,
  { type: BuzzSpendType; direction: BuzzDeltaDirection; total: number; count: number; big: boolean }
>();
let seq = 0;
let listening = false;

const keyOf = (type: BuzzSpendType, direction: BuzzDeltaDirection): BuzzDeltaKey =>
  `${type}:${direction}`;

function isTabHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export const useBuzzDeltaStore = create<BuzzDeltaState>()((set, get) => {
  function settle(key: BuzzDeltaKey) {
    timers.delete(key);
    const group = get().groups[key];
    if (!group) return;
    set((state) => {
      const groups = { ...state.groups };
      delete groups[key];
      return { groups, settled: { ...group, seq: ++seq } };
    });
  }

  function open(
    type: BuzzSpendType,
    direction: BuzzDeltaDirection,
    amount: number,
    count: number,
    big: boolean
  ) {
    const key = keyOf(type, direction);
    set((state) => {
      const prev = state.groups[key];
      const next: OpenGroup = {
        type,
        direction,
        total: (prev?.total ?? 0) + amount,
        count: (prev?.count ?? 0) + count,
        big: (prev?.big ?? false) || big,
      };
      return { groups: { ...state.groups, [key]: next } };
    });
    clearTimeout(timers.get(key));
    const hold = get().groups[key]?.big ? BUZZ_DELTA_BIG_HOLD_MS : BUZZ_DELTA_QUIET_MS;
    timers.set(
      key,
      setTimeout(() => settle(key), hold)
    );
  }

  function flushPending() {
    if (isTabHidden()) return;
    for (const entry of [...pending.values()]) {
      open(entry.type, entry.direction, entry.total, entry.count, entry.big);
    }
    pending.clear();
  }

  return {
    groups: {},
    settled: null,

    record: (type, delta) => {
      if (!delta) return;
      const direction: BuzzDeltaDirection = delta < 0 ? 'debit' : 'credit';
      const amount = Math.abs(delta);
      const big = amount >= BUZZ_DELTA_BIG_AMOUNT;

      if (isTabHidden()) {
        if (!listening) {
          listening = true;
          document.addEventListener('visibilitychange', flushPending);
        }
        const key = keyOf(type, direction);
        const prev = pending.get(key);
        pending.set(key, {
          type,
          direction,
          total: (prev?.total ?? 0) + amount,
          count: (prev?.count ?? 0) + 1,
          big: (prev?.big ?? false) || big,
        });
        return;
      }

      open(type, direction, amount, 1, big);
    },

    reset: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      set({ groups: {}, settled: null });
    },
  };
});

/**
 * Feeds a `BuzzUpdate` signal into the store. Accounts that are not spend accounts never move the
 * header counter, and `toClientType` throws for API account types it has no client name for.
 */
export function recordBuzzUpdate({ accountType, delta }: { accountType: string; delta: number }) {
  let type: string;
  try {
    type = BuzzTypes.toClientType(accountType);
  } catch {
    return;
  }
  if (!buzzSpendTypes.includes(type as BuzzSpendType)) return;
  useBuzzDeltaStore.getState().record(type as BuzzSpendType, delta);
}

export type BuzzDeltaSummary = {
  total: number;
  count: number;
  big: boolean;
  /** The account that moved the most of `total`, which the pop takes its colour from. */
  type: BuzzSpendType;
};

/** The open groups for the given accounts, summed per direction. */
export function useBuzzDeltaGroups(accountTypes: BuzzSpendType[]) {
  const groups = useBuzzDeltaStore((state) => state.groups);
  const typesKey = accountTypes.join(',');

  return useMemo(() => {
    const result: Partial<Record<BuzzDeltaDirection, BuzzDeltaSummary & { top: number }>> = {};
    const wanted = typesKey.split(',');
    for (const group of Object.values(groups)) {
      if (!group || !wanted.includes(group.type)) continue;
      const prev = result[group.direction];
      const leads = !prev || group.total > prev.top;
      result[group.direction] = {
        total: (prev?.total ?? 0) + group.total,
        count: (prev?.count ?? 0) + group.count,
        big: (prev?.big ?? false) || group.big,
        type: leads ? group.type : prev.type,
        top: leads ? group.total : prev.top,
      };
    }
    return result as Partial<Record<BuzzDeltaDirection, BuzzDeltaSummary>>;
  }, [groups, typesKey]);
}
