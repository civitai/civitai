import { useContext, createContext } from 'react';

export type MediaTypes = 'model' | 'review';
interface SfwContextInterface {
  nsfw: boolean;
  showNsfw: boolean;
  type: MediaTypes;
  id: number;
}

export const SfwCtx = createContext<SfwContextInterface>({} as any);
export const useSfwContext = () => {
  const context = useContext(SfwCtx);
  if (!context) throw new Error('useMediaContext can only be used inside Media');
  return context;
};
