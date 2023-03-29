import { removeEmpty } from '~/utils/object-helpers';

type Props = {
  postId?: number;
  modelId?: number;
  modelVersionId?: number;
  username?: string;
  prioritizedUserIds?: number[];
} & Record<string, unknown>;

export function parseImageFilters() {
  const baseFilters: Record<string, unknown> = {};
}
