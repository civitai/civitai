import type { ModelById } from '~/types/router';

/**
 * ModelWithTags represents a Model with flattened tags structure.
 * This type is used across Resource components to avoid circular dependencies.
 */
export type ModelWithTags = Omit<ModelById, 'tagsOnModels'> & {
  tagsOnModels: Array<{ isCategory: boolean; id: number; name: string }>;
};
