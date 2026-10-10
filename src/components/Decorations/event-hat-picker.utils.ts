import { minutesUntilMovable } from '~/components/Events/ScoredEvent/scored-event.utils';

type PickerHat = {
  cosmeticId: number;
  placedOn: { entityType: string; entityId: number; title?: string | null } | null;
  moveCooldownLeftMs: number;
};

export type HatState =
  | { kind: 'here' }
  | { kind: 'cooldown'; minutes: number }
  /** `title` is null for untitled content (most images). */
  | { kind: 'elsewhere'; entityType: string; title: string | null }
  | { kind: 'free' }
  | { kind: 'ready' };

/**
 * Where a hat stands for the content the picker is open on. The cooldown is what the server said was
 * left (on its own clock) less the time since the hats arrived (both ends on the browser's clock), so
 * nothing here re-derives the ten minutes or compares the browser's clock with the server's.
 */
export function getHatState(
  hat: PickerHat,
  {
    entityType,
    entityId,
    joinCosmeticId,
    now,
    fetchedAt,
  }: {
    entityType: string;
    entityId: number;
    joinCosmeticId?: number;
    /** Browser clock, ms. */
    now: number;
    /** When the hats arrived, on the browser's clock (the query's dataUpdatedAt). */
    fetchedAt: number;
  }
): HatState {
  if (hat.placedOn?.entityType === entityType && hat.placedOn.entityId === entityId)
    return { kind: 'here' };
  const minutes = minutesUntilMovable(hat.moveCooldownLeftMs, now - fetchedAt);
  if (minutes > 0) return { kind: 'cooldown', minutes };
  if (hat.placedOn)
    return {
      kind: 'elsewhere',
      entityType: hat.placedOn.entityType,
      title: hat.placedOn.title ?? null,
    };
  if (hat.cosmeticId === joinCosmeticId) return { kind: 'free' };
  return { kind: 'ready' };
}

export function canPutOn(state: HatState) {
  return state.kind !== 'here' && state.kind !== 'cooldown';
}

/** The hat the picker opens on: one that is not worn anywhere, else one that can move, else the first. */
export function pickDefaultHat<T extends PickerHat>(
  hats: T[],
  context: Parameters<typeof getHatState>[1]
) {
  const states = hats.map((hat) => getHatState(hat, context));
  const at = (test: (s: HatState) => boolean) => states.findIndex(test);
  const index = [
    at((s) => s.kind === 'ready' || s.kind === 'free'),
    at(canPutOn),
    hats.length ? 0 : -1,
  ].find((i) => i >= 0);
  return index === undefined ? undefined : hats[index];
}
