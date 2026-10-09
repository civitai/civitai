import { ChangesState, changesStorageKey, type ChangesFields } from './changes';

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function createChanges(moderatorId: number): ChangesState {
  const fields = $state<ChangesFields>({ changes: {}, current: null });
  return new ChangesState(fields, browserStorage(), changesStorageKey(moderatorId));
}
