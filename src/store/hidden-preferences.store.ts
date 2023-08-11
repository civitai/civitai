import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import {
  HiddenPreferencesOutput,
  hiddenPreferencesSchema,
} from '~/server/schema/user-preferences.schema';

type UserPreferencesStore = HiddenPreferencesOutput & {
  getPreferences: () => Promise<void>;
  toggleTags: (tagIds: number[], hidden?: boolean) => Promise<void>;
  toggleEntity: (args: {
    entityId: number;
    entityType: 'model' | 'user' | 'image';
  }) => Promise<void>;
  toggleTagVote: (args: {
    vote: -1 | 0 | 1;
    tagId: number;
    entityId: number;
    entityType: 'model' | 'image';
  }) => Promise<void>;
};

export const useUserPreferencesStore = create<UserPreferencesStore>()(
  devtools(
    immer((set, get) => ({
      explicit: { images: [], models: [], users: [] },
      hidden: { tags: [], images: [], models: [] },
      moderated: { tags: [], images: [], models: [] },
      getPreferences: async () => {
        const data = await fetchPreferences();
        set({ ...data });
      },
      toggleTags: async (tagIds, hidden) => {
        set((state) => {
          if (hidden === true) state.hidden.tags = [...state.hidden.tags, ...tagIds];
          else if (hidden === false)
            state.hidden.tags = state.hidden.tags.filter((x) => !tagIds.includes(x));
          else {
            for (const id of tagIds) {
              const index = state.hidden.tags.findIndex((x) => x === id);
              if (index > -1) state.hidden.tags.splice(index, 1);
              else state.hidden.tags.push(id);
            }
          }
        });
        const data = await toggleHiddenTags(tagIds, hidden);
        set((state) => {
          state.hidden = data;
        });
      },
      toggleEntity: async ({ entityType, entityId }) => {
        set((state) => {
          const key = `${entityType}s` as keyof HiddenPreferencesOutput['explicit'];
          const current = state.explicit[key];
          const index = current.indexOf(entityId);
          if (index > -1) current.splice(index, 1);
          else current.push(entityId);
        });
        await toggleHiddenEntity({ entityType, entityId });
      },
      toggleTagVote: async ({ vote, tagId, entityId, entityType }) => {
        set((state) => {
          const moderatedIndex = state.moderated.tags.indexOf(tagId);
          const hiddenIndex = state.hidden.tags.indexOf(tagId);
          const key = `${entityType}s` as 'models' | 'images';

          const moderatedEntityIndex = state.moderated[key].indexOf(entityId);
          const hiddenEntityIndex = state.hidden[key].indexOf(entityId);

          if (vote < 1) {
            // remove model/image associated with tag from hidden/moderated
            if (moderatedIndex > -1 && moderatedEntityIndex > -1)
              state.moderated[key].splice(moderatedEntityIndex, 1);
            if (hiddenIndex > -1 && hiddenEntityIndex > -1)
              state.hidden[key].splice(hiddenEntityIndex, 1);
          } else {
            // add model/image associated with tag to hidden/moderated
            if (moderatedIndex > -1 && moderatedEntityIndex === -1)
              state.moderated[key].push(entityId);
            if (hiddenIndex > -1 && hiddenEntityIndex === -1) state.hidden[key].push(entityId);
          }
        });
      },
    })),
    { name: 'user-preferences' }
  )
);

const store = useUserPreferencesStore.getState();
export const hiddenPreferences = {
  getPreferences: store.getPreferences,
  toggleTags: store.toggleTags,
  toggleEntity: store.toggleEntity,
  toggleTagVote: store.toggleTagVote,
};

const fetchPreferences = async () => {
  const result = await fetch('/api/user/preferences');
  if (!result.ok) throw new Error('could not fetch user preferences');
  const data = await result.json();
  return hiddenPreferencesSchema.parse(data);
};

const toggleHiddenTags = async (tagIds: number[], hidden?: boolean) => {
  const result = await fetch('', {
    method: 'POST',
    body: JSON.stringify({ tagIds, hidden }),
  });
  if (!result.ok) throw new Error('could not toggle hidden tags');
  const data = (await result.json()) as {
    tags: number[];
    images: number[];
    models: number[];
  };
  return data;
};

const toggleHiddenEntity = async ({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: 'model' | 'image' | 'user';
}) => {
  const result = await fetch('', {
    method: 'POST',
    body: JSON.stringify({ entityId, entityType }),
  });
  if (!result.ok) throw new Error(`could not toggle hide entity: ${entityType} of id: ${entityId}`);
};
