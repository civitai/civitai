import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useProfanityBlocklist } from '~/hooks/useBenignPhrases';
import type { ManagedProfanityList } from '~/libs/profanity-simple';

export const ProfanityBlocklistCtx = createContext<ManagedProfanityList | null>(null);

/** The managed blocked list for render paths, read once for the app rather than per instance. */
export const useManagedProfanityBlocklist = () => useContext(ProfanityBlocklistCtx);

export function ProfanityBlocklistProvider({ children }: { children: ReactNode }) {
  const blocklist = useProfanityBlocklist();
  return (
    <ProfanityBlocklistCtx.Provider value={blocklist}>{children}</ProfanityBlocklistCtx.Provider>
  );
}
