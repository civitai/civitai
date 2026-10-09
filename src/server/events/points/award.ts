// TEMPORARY STUB so the hooks typecheck before the engine's core lands on feat/event-points.
// The core PR owns this file; on merging it, take its version and delete this stub.
import type { EventPointAction, EventPointRemoval } from './types';

export async function awardEventPoints(_actions: EventPointAction[]): Promise<void> {
  return;
}

export async function removeEventPoints(_removals: EventPointRemoval[]): Promise<void> {
  return;
}

export function isHattedEntity(_entityType: string, _entityId: number): boolean {
  return false;
}
