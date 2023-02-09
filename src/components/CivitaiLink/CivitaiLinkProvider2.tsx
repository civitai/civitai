import { createStore, useStore } from 'zustand';
import { createContext, useContext, useRef } from 'react';
import { immer } from 'zustand/middleware/immer';
// import createContext from 'zustand/context';

// const { Provider, useStore } = createContext();

// const createStore2 = () => create()(immer((set, get) => ({})));

// export function CivitaiLinkProvider2({ children }: { children: React.ReactElement }) {
//   return <Provider createStore={() => createStore2()}>{children}</Provider>;
// }

type ContextProps = {
  socketConnected: boolean;
  connected: boolean;
};

type StoreProps = ContextProps & {
  setSocketConnected: (value: boolean) => void;
  setConnected: (value: boolean) => void;
};

const createMyStore = () =>
  createStore<ContextProps>()(
    immer((set, get) => ({
      connected: false,
      socketConnected: false,
    }))
  );

const MyContext = createContext<ReturnType<typeof createMyStore> | null>(null);

const Provider = ({ children }: { children: React.ReactElement }) => {
  const storeRef = useRef<ReturnType<typeof createMyStore>>();

  if (!storeRef.current) {
    storeRef.current = createMyStore();
  }

  return <MyContext.Provider value={storeRef.current}>{children}</MyContext.Provider>;
};

export function useContextStore<T>(selector: (state: ContextProps) => T) {
  const store = useContext(MyContext);
  if (store === null) {
    throw new Error('Missing CivitaiLinkProvider in the tree');
  }
  const value = useStore(store, selector);
  return value;
}
