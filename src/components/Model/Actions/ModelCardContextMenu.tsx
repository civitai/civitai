import { createContext, useContext } from 'react';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';

type ModelCardMenuCtx = {
  setMenuItems?: (
    data: UseQueryModelReturn[number],
    menuItems: { key: string; component: React.ReactNode }[]
  ) => { key: string; component: React.ReactNode }[];
};

const ModelCardContextMenu = createContext<ModelCardMenuCtx>({});
export const useModelCardContextMenu = () => useContext(ModelCardContextMenu);

export function ModelContextMenuProvider({
  children,
  ...props
}: ModelCardMenuCtx & { children: React.ReactNode }) {
  return <ModelCardContextMenu.Provider value={props}>{children}</ModelCardContextMenu.Provider>;
}
