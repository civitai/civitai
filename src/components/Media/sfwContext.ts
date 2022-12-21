import { useContext, createContext } from 'react';

export type MediaTypes = 'model' | 'review';
interface SfwContextInterface {
  nsfw: boolean;
  showNsfw: boolean;
  type: MediaTypes;
  id: number;
}

export const SfwCtx = createContext<SfwContextInterface>({} as any); // eslint-disable-line
export const useSfwContext = () => {
  const context = useContext(SfwCtx);
  if (!context) throw new Error('useSfwContext can only be used inside SfwCtx');
  return context;
};
