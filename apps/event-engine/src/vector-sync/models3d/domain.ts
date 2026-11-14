import { config } from '@/config';
import { imageEmbedUrl } from '../embedder';
import type { Domain, DomainRef } from '../domain/sync';
import { model3dVectorStore } from './collection';
import { getModel3DDocs, type Model3DPayload } from './source';

export const MODEL3D_TOPICS = ['postgres.Model3D', 'postgres.TagsOnModel3D'];

/**
 * The 3D model a CDC message touches. TagsOnModel3D's key includes model3dId, so a tag removal
 * names its model. The delete is soft, so it arrives as an update. A thumbnail's first rating
 * reaches the model through the nsfwLevel it writes on the Model3D row (0 to rated). A later flag
 * on the thumbnail, an owner ban or a hold changes no Model3D row: the refresh walk re-syncs every
 * model and deletes the point.
 */
export function model3dRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Model3D' ? row.id : row.model3dId;
  return typeof id === 'number' && id > 0 ? { id } : null;
}

export const MODEL3D_REFRESH = { everyMs: 15 * 60_000, batch: 500 };

export const model3dDomain: Domain<Model3DPayload> = {
  name: 'model3d',
  table: 'Model3D',
  getDocs: getModel3DDocs,
  topics: MODEL3D_TOPICS,
  refFromEvent: model3dRefFromEvent,
  cdcTables: ['public.Model3D', 'public.TagsOnModel3D'],
  refresh: MODEL3D_REFRESH,
  embedInput: (id, payload) => {
    const imageUrl = imageEmbedUrl(payload.thumbnailUrl);
    return imageUrl ? { id: String(id), imageUrl } : null;
  },
  store: model3dVectorStore,
  alias: () => config.vectorSync.model3dAlias,
};
