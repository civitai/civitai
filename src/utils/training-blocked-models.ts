// Blocked base models in the training service status (`training:status` in sys redis). Training Studio
// reads the same list with the same keys (`apps/training-studio/src/lib/service-status-core.ts`).

import { trainingModelInfo } from '~/utils/training';

export const UNAVAILABLE_LABEL = 'Temporarily unavailable';

type BlockedModelsStatus = {
  blockedModels?: string[] | null;
  blockedModelReasons?: Record<string, string> | null;
};

/** A `trainingModelInfo` key, as opposed to a blocked custom-model AIR. */
export function isBaseModelKey(key: string): boolean {
  return Object.hasOwn(trainingModelInfo, key);
}

/** Whether a base-model key is down, and the note to show under "Temporarily unavailable". */
export function modelUnavailability(
  status: BlockedModelsStatus | null | undefined,
  key: string
): { reason: string | null } | null {
  if (!status?.blockedModels?.includes(key)) return null;
  const reason = status.blockedModelReasons?.[key];
  return { reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null };
}

export function unavailableModelMessage(name: string, reason: string | null): string {
  return `${name} is temporarily unavailable for training.${reason ? ` ${reason}` : ''}`;
}

/** Apply the moderator editor's list of blocked base models. Entries that are not base-model keys
 *  (blocked custom-model AIRs) are kept as they are; a reason is kept only for a blocked key. */
export function mergeBlockedModels(
  current: string[],
  input: { blockedModels: string[]; blockedModelReasons?: Record<string, string> | null },
  isBaseModelKey: (key: string) => boolean
): { blockedModels: string[]; blockedModelReasons: Record<string, string> } {
  const blocked = [...new Set(input.blockedModels)];
  const reasons: Record<string, string> = {};
  for (const key of blocked) {
    const reason = input.blockedModelReasons?.[key]?.trim();
    if (reason) reasons[key] = reason;
  }
  return {
    blockedModels: [...current.filter((key) => !isBaseModelKey(key)), ...blocked],
    blockedModelReasons: reasons,
  };
}
