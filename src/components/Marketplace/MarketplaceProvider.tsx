import { createContext, useContext, useState } from 'react';
import { Currency } from '~/shared/utils/prisma/enums';

type ProviderState = {
  currency: Currency;
  setCurrency: (currency: Currency) => void;
};

const MarketplaceContext = createContext<ProviderState | undefined>(undefined);
export const useMarketplaceContext = () => {
  const context = useContext(MarketplaceContext);
  if (!context) {
    throw new Error('useMarketplaceContext must be used within a MarketPlaceProvider');
  }
  return context;
};

export function MarketplaceProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrency] = useState<Currency>(Currency.USD);

  return (
    <MarketplaceContext.Provider value={{ currency, setCurrency }}>
      {children}
    </MarketplaceContext.Provider>
  );
}
