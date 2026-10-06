import { ChangesState, emptyChangesFields, type ChangesInit } from './changes';
import { postAction } from './post-action';

export function createChanges(init: ChangesInit): ChangesState {
  const fields = $state(emptyChangesFields());
  return new ChangesState(fields, postAction, init);
}
