import { useDisclosure } from '@mantine/hooks';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { createContext, type Dispatch, type SetStateAction, useContext, useState } from 'react';
import type { GetAllAuctionsReturn } from '~/server/services/auction.service';
import type { GenerationResource } from '~/shared/types/generation.types';

type AuctionState = {
  selectedAuction: GetAllAuctionsReturn[number] | undefined;
  selectedModel: GenerationResource | undefined;
  validAuction: boolean;
  justBid: { auctionId: number; entityId: number } | undefined;
  viewing: { [p: number]: number };
};
type AuctionContextState = {
  selectedAuction: AuctionState['selectedAuction'];
  selectedModel: AuctionState['selectedModel'];
  validAuction: AuctionState['validAuction'];
  justBid: AuctionState['justBid'];
  viewing: AuctionState['viewing'];
  setSelectedAuction: Dispatch<SetStateAction<AuctionState['selectedAuction']>>;
  setSelectedModel: Dispatch<SetStateAction<AuctionState['selectedModel']>>;
  setValidAuction: Dispatch<SetStateAction<AuctionState['validAuction']>>;
  setJustBid: Dispatch<SetStateAction<AuctionState['justBid']>>;
  setViewing: Dispatch<SetStateAction<AuctionState['viewing']>>;
  drawerIsOpen: boolean;
  drawerToggle: () => void;
  drawerClose: () => void;
  chooseAuction: (a: AuctionState['selectedAuction']) => void;
};

const AuctionContext = createContext<AuctionContextState | null>(null);

export const useAuctionContext = () => {
  const context = useContext(AuctionContext);
  if (!context) throw new Error('AuctionContext not in tree');
  return context;
};

export const MY_BIDS = 'my-bids';

export const AuctionContextProvider = ({ children }: { children: ReactNode }) => {
  const [selectedAuction, setSelectedAuction] =
    useState<AuctionState['selectedAuction']>(undefined);
  const [selectedModel, setSelectedModel] = useState<AuctionState['selectedModel']>(undefined);
  const [validAuction, setValidAuction] = useState<AuctionState['validAuction']>(true);
  const [justBid, setJustBid] = useState<AuctionState['justBid']>(undefined);
  const [viewing, setViewing] = useState<AuctionState['viewing']>({});
  const [drawerIsOpen, { close: drawerClose, toggle: drawerToggle }] = useDisclosure();
  const router = useRouter();

  const chooseAuction = (a: AuctionState['selectedAuction']) => {
    if (!a || (a?.id && selectedAuction?.id !== a.id)) {
      setSelectedAuction(a);
      setSelectedModel(undefined);
      setValidAuction(true);
      router
        .push(
          {
            query: { slug: !!a ? a.auctionBase.slug : MY_BIDS },
          },
          undefined,
          { shallow: true }
        )
        .catch();
    }
    drawerClose();
  };

  return (
    <AuctionContext.Provider
      value={{
        selectedAuction,
        selectedModel,
        validAuction,
        justBid,
        viewing,
        setSelectedAuction,
        setSelectedModel,
        setValidAuction,
        setJustBid,
        setViewing,
        drawerIsOpen,
        drawerToggle,
        drawerClose,
        chooseAuction,
      }}
    >
      {children}
    </AuctionContext.Provider>
  );
};
