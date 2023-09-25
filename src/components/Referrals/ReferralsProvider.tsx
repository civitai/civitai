import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { deleteCookies, setCookie } from '~/utils/cookies-helpers';
import dayjs from 'dayjs';
import { useCookies } from '~/providers/CookiesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type ReferralsState = {
  code?: string;
  source?: string;
};

const ReferralsContext = createContext<ReferralsState | null>(null);
export const useReferralsContext = () => {
  const context = useContext(ReferralsContext);
  if (!context) throw new Error('ReferralsContext not in tree');
  return context;
};

const schema = z.object({
  ref_id: z.string().optional(),
  ref_code: z.string().optional(),
  ref_source: z.string().optional(),
});

export const ReferralsProvider = ({ children }: { children: React.ReactNode }) => {
  const user = useCurrentUser();
  const router = useRouter();
  const { referrals } = useCookies();
  const result = schema.safeParse(router.query);
  const [code, setCode] = useState<string | undefined>(referrals.code);
  const [source, setSource] = useState<string | undefined>(referrals.source);

  useEffect(() => {
    if (result.success && !user?.referral) {
      const { ref_id, ref_source, ref_code } = result.data;
      const { code, source } = referrals;
      const expirationDate = dayjs().add(5, 'day').toDate();

      if (ref_id && ref_id !== code) {
        setCookie('ref_code', ref_id, expirationDate);
        setCode(ref_id);
      }
      if (ref_code && ref_code !== code) {
        setCookie('ref_code', ref_code, expirationDate);
        setCode(ref_code);
      }
      if (ref_source && ref_source !== source) {
        setCookie('ref_source', ref_source, expirationDate);
        setSource(ref_source);
      }
    }
  }, [result.success, user]);

  return (
    <ReferralsContext.Provider
      value={{
        code,
        source,
      }}
    >
      {children}
    </ReferralsContext.Provider>
  );
};
