import { createContext, useContext } from 'react';
import type { ModelById } from '~/types/router';

type ModelVersionsProps = { id: number; name: string; modelId: number };
type ImagesAsPostsInfiniteState = {
  model: ModelById;
  modelVersions?: ModelVersionsProps[];
  filters: {
    modelId?: number;
    username?: string;
    modelVersionId?: number;
  } & Record<string, unknown>;
  showModerationOptions?: boolean;
};
const ImagesAsPostsInfiniteContext = createContext<ImagesAsPostsInfiniteState | null>(null);
export const useImagesAsPostsInfiniteContext = () => {
  const context = useContext(ImagesAsPostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

export function ImagesAsPostsInfiniteProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ImagesAsPostsInfiniteState;
}) {
  return (
    <ImagesAsPostsInfiniteContext.Provider value={value}>
      {children}
    </ImagesAsPostsInfiniteContext.Provider>
  );
}
