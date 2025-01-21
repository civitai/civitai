import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

// type StoreState = {
//   resources: GenerationResource[];
//   baseModel: string;
//   addResources: (resources: GenerationResource[]) => void;
//   setResources: (resources: GenerationResource[]) => void;
//   removeResource: (id: number) => void;
// };

// const useGenerationResourceStore = create<StoreState>()(
//   immer(
//     persist(
//       (set, get) => ({
//         resources: [] as GenerationResource[],
//         baseModel: 'Flux1',
//         addResources: (resources) => {
//           set((state) => {
//             state.baseModel = getBaseModel(resources);
//           });
//         },
//         setResources: (resources) => {
//           set((state) => {
//             state.resources = resources;
//             state.baseModel = getBaseModel(resources);
//           });
//         },
//         removeResource: (id) => {
//           set((state) => {
//             state.resources = state.resources.filter((x) => x.id !== id);
//           });
//         },
//       }),
//       { name: 'generation-resources' }
//     )
//   )
// );

// function setGenerationResources(resources: GenerationResource[]) {}

// function getBaseModel(resources: GenerationResource[]) {
//   return getBaseModelFromResources(
//     resources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
//   );
// }

// function reduceResources(resources: GenerationResource[]) {
//   return resources.reduce<Partial<Record<ModelType, GenerationResource[]>>>((acc, resource) => {
//     const type = resource.model.type;
//     acc[type] = [...(acc[type] ?? []), resource];
//     return acc;
//   }, {});
// }

// export function ResourceSelectProvider({ children }: { children: React.ReactNode }) {
//   return <>{children}</>;
// }
