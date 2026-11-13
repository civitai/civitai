import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { modelVectorStore } from './collection';
import { getModelDocs, type ModelPayload } from './source';

export const MODEL_TOPICS = ['postgres.Model', 'postgres.ModelVersion', 'postgres.TagsOnModels'];
/** The tables whose changes decide a model's eligibility; embedding waits until both stream. */
export const MODEL_CDC_TABLES = ['public.Model', 'public.ModelVersion'];

export type ModelRef = { model: number } | { version: number };

/**
 * What a CDC message touches. A ModelVersion delete carries only the version's own id (the
 * table's replica identity is its key); the queue finds its model through the payload.
 */
export function modelRefFromEvent(topic: string, value: unknown): ModelRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Model' ? row.id : row.modelId;
  if (typeof id === 'number') return { model: id };
  if (topic === 'postgres.ModelVersion' && event.op === 'd' && typeof row.id === 'number')
    return { version: row.id };
  return null;
}

export const toDomainRef = (ref: ModelRef | null): DomainRef | null =>
  !ref ? null : 'model' in ref ? { id: ref.model } : { child: ref.version };

export const modelDomain: Domain<ModelPayload> = {
  name: 'model',
  table: 'Model',
  getDocs: getModelDocs,
  topics: MODEL_TOPICS,
  refFromEvent: (topic, value) => toDomainRef(modelRefFromEvent(topic, value)),
  cdcTables: MODEL_CDC_TABLES,
  childField: 'versionIds',
  embedByDefault: true,
  store: modelVectorStore,
  alias: () => config.vectorSync.modelAlias,
};
