import { ChangesState, emptyChangesFields, type ChangesInit } from './changes';
import { postAction } from './post-action';

/** The page's ChangesState, its fields held in one deep `$state` so every read is reactive. */
export function createChanges(init: ChangesInit): ChangesState {
  const fields = $state(emptyChangesFields());
  return new ChangesState(fields, postAction, init);
}
