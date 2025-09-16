import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { setCookie } from '~/utils/cookies-helpers';
import dayjs from '~/shared/utils/dayjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type ReferralsState = {
  code?: string;
  source?: string;
  landingPage?: string;
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

export const ReferralsProvider = ({
  children,
  ...referrals
}: {
  children: React.ReactNode;
  code?: string;
  source?: string;
  landingPage?: string;
}) => {
  const user = useCurrentUser();
  const router = useRouter();
  const result = schema.safeParse(router.query);
  const [code, setCode] = useState<string | undefined>(referrals.code);
  const [source, setSource] = useState<string | undefined>(referrals.source);
  const [landingPage, setLandingPage] = useState<string | undefined>(referrals.landingPage);

  useEffect(() => {
    if (result.success && !user?.referral) {
      const { ref_id, ref_source, ref_code } = result.data;

      const { code, source, landingPage } = referrals;
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
      if (!landingPage) {
        // Only set this whenever we don't have a landing page recorded in the cookies.
        setCookie('ref_landing_page', router.asPath, expirationDate);
        setLandingPage(router.asPath);
      }
    }
  }, [result.success, user]);

  return (
    <ReferralsContext.Provider
      value={{
        code,
        source,
        landingPage,
      }}
    >
      {children}
    </ReferralsContext.Provider>
  );
};
