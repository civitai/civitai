/**
 * Zero imports, so the notification processors can build these URLs without pulling a component
 * graph into the job runner.
 */

export const STORYLINES_URL = '/storylines';

export function storylineUrl(storylineId: number) {
  return `${STORYLINES_URL}/${storylineId}`;
}
