import { ModelType } from '@prisma/client';
import { Generation } from '~/server/services/generation/generation.types';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { WritableDraft } from 'immer/dist/internal';
import { ZodError, z } from 'zod';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import { devtools } from 'zustand/middleware';
type Errors = Partial<Record<ModelType, string[] | undefined>>;
type GenerationResourcesState = {
  hasUnavailable: boolean;
  errors: Errors;
  baseModels: string[];
  resources: Record<ModelType, Generation.Resource[]>;
  setResources: (resources: Generation.Resource[]) => void;
  addResource: (resource: Generation.Resource) => void;
  updateResource: (resource: Generation.Resource) => void;
  removeResource: (resourceId: number) => void;
  removeBaseModel: (value: string) => void;
  getValidatedResources: () => Generation.Resource[] | undefined;
};

export const useGenerationResourceStore = create<GenerationResourcesState>()(
  devtools(
    immer((set, get) => {
      const updateBaseModels = (state: WritableDraft<GenerationResourcesState>) => {
        const resources = Object.values(state.resources).flatMap((x) => x);
        state.baseModels = [...new Set(resources.map((x) => x.baseModel))];
        state.hasUnavailable = resources.some((x) => x.covered === false);
      };

      return {
        errors: {},
        baseModels: [],
        hasUnavailable: false,
        resources: Object.keys(ModelType).reduce<Record<ModelType, Generation.Resource[]>>(
          (acc, key) => ({ ...acc, [key as ModelType]: [] }),
          {} as Record<ModelType, Generation.Resource[]>
        ),

        setResources: (resources) => {
          set((state) => {
            for (const type in ModelType) {
              state.resources[type as ModelType] = resources.filter((x) => x.modelType === type);
            }
            updateBaseModels(state);
            state.errors = {};
          });
        },
        addResource: (resource) => {
          set((state) => {
            state.resources[resource.modelType].push(resource);
            updateBaseModels(state);
          });
        },
        updateResource: (resource) => {
          set((state) => {
            const index = state.resources[resource.modelType].findIndex(
              (x) => x.id === resource.id
            );
            if (index > -1) state.resources[resource.modelType][index] = resource;
          });
        },
        removeResource: (resourceId) => {
          set((state) => {
            for (const type in ModelType) {
              const resources = state.resources[type as ModelType];
              const index = resources.findIndex((x) => x.id === resourceId);
              if (index > -1) resources.splice(index, 1);
            }
            updateBaseModels(state);
          });
        },
        removeBaseModel: (value) => {
          set((state) => {
            const index = state.baseModels.indexOf(value);
            if (index > -1) state.baseModels.splice(index, 1);

            for (const type in ModelType) {
              const resources = state.resources[type as ModelType];
              const index = resources.findIndex((x) => x.baseModel === value);
              if (index > -1) resources.splice(index, 1);
            }
          });
        },
        getValidatedResources: () => {
          try {
            const resources = resourceSchema.parse(get().resources);
            set((state) => {
              state.errors = {};
            });
            return Object.values(resources).flatMap((x) => x) as Generation.Resource[];
          } catch (e: any) {
            const error: ZodError = e;
            set((state) => {
              state.errors = error.flatten().fieldErrors as Errors;
            });
          }
        },
      };
    })
  )
);

const resourceSchema = z
  .object({
    [ModelType.Checkpoint]: generationResourceSchema
      .array()
      .min(1, 'A model checkpoint is required')
      .max(1),
    // [ModelType.LORA]: generationResourceSchema.extend({ strength: z.number().min(2) }),
  })
  .passthrough();
