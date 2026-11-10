import { syncIds, type DomainStore, type DomainSyncDeps, type SyncStats } from '../domain/sync';
import { getModelDocs, type ModelPayload } from './source';

export type ModelStore = DomainStore<ModelPayload>;
export type ModelSyncDeps = DomainSyncDeps<ModelPayload>;
export type ModelSyncStats = SyncStats;
export { emptyStats as emptyModelStats } from '../domain/sync';

/** Makes the models collection match these models' current state; see syncIds. */
export const syncModelIds = (ids: number[], deps: ModelSyncDeps): Promise<ModelSyncStats> =>
  syncIds(getModelDocs, ids, deps);
