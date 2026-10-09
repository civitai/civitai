// TEMPORARY STUB of the core PR's read.ts, with its exact signatures. Replaced by the real module
// when feat/event-points-live merges the core PR; never ships.
import type { EventHat } from './types';

type SeasonEvent = { name: string; startDate: Date };

export async function getHatPoints(
  _event: SeasonEvent,
  _hats: Omit<EventHat, 'team'>[],
  _now?: Date
): Promise<Record<string, number>> {
  throw new Error('event points core not merged');
}

export async function getTeamPoints(
  _event: SeasonEvent & { teams: readonly string[] },
  _now?: Date
): Promise<Record<string, number>> {
  throw new Error('event points core not merged');
}

export async function getOwnerPoints(
  _event: SeasonEvent,
  _ownerIds: number[],
  _now?: Date
): Promise<Record<number, number>> {
  throw new Error('event points core not merged');
}

export async function drainChangedHats(
  _event: { name: string },
  _max: number
): Promise<Omit<EventHat, 'team'>[]> {
  throw new Error('event points core not merged');
}
