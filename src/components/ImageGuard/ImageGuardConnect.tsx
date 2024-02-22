import { createContext, useCallback, useContext } from 'react';
import { create } from 'zustand';

type ConnectId = string | number;
type ConnectType =
  | 'model'
  | 'modelVersion'
  | 'review'
  | 'user'
  | 'post'
  | 'collectionItem'
  | 'collection'
  | 'bounty'
  | 'bountyEntry'
  | 'club'
  | 'article';

type ImageGuardConnect = {
  connectType: ConnectType;
  connectId: ConnectId;
};

type ImageGuardConnectCtxState = {
  showConnect: boolean;
  toggleShowConnect: () => void;
};
const ImageGuardConnectContext = createContext<Partial<ImageGuardConnectCtxState>>({});

const useShowConnectionStore = create<Record<string, boolean>>(() => ({}));
function getConnectionKey({ connectId, connectType }: ImageGuardConnect) {
  return `${connectId}_${connectType}`;
}

export function useImageGuardConnectContext() {
  const context = useContext(ImageGuardConnectContext);
  return context ?? {};
}

export function ImageGuardConnect({
  connectType,
  connectId,
  children,
}: ImageGuardConnect & { children: React.ReactNode }) {
  const showConnect = useShowConnectionStore(
    useCallback(
      (state) => state[getConnectionKey({ connectType, connectId })],
      [connectType, connectId]
    )
  );

  const toggleShowConnect = () => {
    const key = getConnectionKey({ connectType, connectId });
    useShowConnectionStore.setState({ [key]: !showConnect });
  };

  return (
    <ImageGuardConnectContext.Provider value={{ showConnect, toggleShowConnect }}>
      {children}
    </ImageGuardConnectContext.Provider>
  );
}
