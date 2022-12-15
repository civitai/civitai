import { useContext, createContext } from 'react';

export type MediaTypes = 'model' | 'review';
interface MediaContextInterface {
  nsfw: boolean;
  showNsfw: boolean;
  type: MediaTypes;
  id: number;
}

export const MediaCtx = createContext<MediaContextInterface>({} as any);
export const useMediaContext = () => {
  const context = useContext(MediaCtx);
  if (!context) throw new Error('useMediaContext can only be used inside Media');
  return context;
};
