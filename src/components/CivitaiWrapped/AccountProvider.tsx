import { useLocalStorage, usePrevious } from '@mantine/hooks';
import { signIn, signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { createContext, ReactNode, useContext, useEffect } from 'react';
import { civTokenEndpoint, EncryptedDataSchema } from '~/server/schema/civToken.schema';
import { deleteCookies } from '~/utils/cookies-helpers';

export type CivitaiAccount = {
  token: EncryptedDataSchema;
  active: boolean;

  email: string;
  username: string;
  avatarUrl?: string;
};
type CivitaiAccounts = Record<string, CivitaiAccount>;
const civitaiAccountsKey = 'civitai-accounts';

type ogAccountType = {
  id: number;
  username: string;
} | null;
const ogAccountKey = 'civitai-og-account';

const deleteCookieList = ['ref_code', 'ref_source'];

type AccountState = {
  accounts: CivitaiAccounts;
  setAccounts: (val: ((prevState: CivitaiAccounts) => CivitaiAccounts) | CivitaiAccounts) => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  swapAccount: (token: EncryptedDataSchema) => Promise<void>;
  removeAccount: (id: number) => void;
  ogAccount: ogAccountType;
  setOgAccount: (val: ((prevState: ogAccountType) => ogAccountType) | ogAccountType) => void;
  removeOgAccount: () => void;
};

const AccountContext = createContext<AccountState | null>(null);

export const useAccountContext = () => {
  const context = useContext(AccountContext);
  if (!context) throw new Error('AccountContext not in tree');
  return context;
};

export const AccountProvider = ({ children }: { children: ReactNode }) => {
  const { data: userData } = useSession();
  const previousUserData = usePrevious(userData);
  const router = useRouter();

  const [accounts, setAccounts, removeAccounts] = useLocalStorage<CivitaiAccounts>({
    key: civitaiAccountsKey,
    defaultValue: {},
    getInitialValueInEffect: false,
  });

  const [ogAccount, setOgAccount, removeOgAccount] = useLocalStorage<ogAccountType>({
    key: ogAccountKey,
    defaultValue: null,
    // getInitialValueInEffect: false,
  });

  const logout = async () => {
    // Remove referral cookies on sign out
    deleteCookies(deleteCookieList);

    // Remove og account storage
    removeOgAccount();

    // - Remove logged out account from account switch list
    //   then log into first account in list if exists
    const userId = userData?.user?.id;
    const userIdStr = !!userId ? userId.toString() : undefined;
    if (!!userIdStr && userIdStr in accounts) {
      const otherAccounts = Object.entries(accounts).filter(([k]) => k !== userIdStr);
      const firstAccount = otherAccounts[0];

      delete accounts[userIdStr];
      setAccounts(accounts);

      if (!!firstAccount) {
        await swapAccount(firstAccount[1].token);
        return;
      }
    }

    await signOut();
  };

  const logoutAll = async () => {
    deleteCookies(deleteCookieList);
    removeOgAccount();
    removeAccounts();
    await signOut();
  };

  const swapAccount = async (token: EncryptedDataSchema) => {
    await signIn('account-switch', { callbackUrl: router.asPath, ...token });
  };

  const removeAccount = (id: number) => {
    delete accounts[id.toString()];
    setAccounts(accounts);
  };

  // - Adjust localstorage active accounts and add new ones
  useEffect(() => {
    const userId = userData?.user?.id;
    const email = userData?.user?.email;
    const username = userData?.user?.username;
    if (!userId || !email || !username) return;

    const userIdStr = userId.toString();

    const getToken = async () => {
      if (!(userIdStr in accounts)) {
        const tokenResp = await fetch(civTokenEndpoint);
        const tokenJson: { token: EncryptedDataSchema } = await tokenResp.json();
        return tokenJson.token;
      } else {
        return accounts[userIdStr].token;
      }
    };

    getToken().then((token) => {
      setAccounts((current) => {
        const old = { ...current };
        Object.keys(old).forEach((k) => {
          old[k]['active'] = false;
        });

        return {
          ...old,
          [userIdStr]: {
            token,
            active: true,

            email,
            username,
            avatarUrl: userData?.user?.image,
          },
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userData?.user?.email, userData?.user?.id, userData?.user?.image, userData?.user?.username]);

  // - reload page when account has changed
  useEffect(() => {
    const reloadIfInactiveAccount = () => {
      if (document.visibilityState === 'visible') {
        const userId = userData?.user?.id;
        const previousUserId = previousUserData?.user?.id;

        if (userId !== previousUserId && previousUserData !== undefined && router.isReady) {
          router.reload();
        }
      }
    };
    document.addEventListener('visibilitychange', reloadIfInactiveAccount);
    return () => {
      document.removeEventListener('visibilitychange', reloadIfInactiveAccount);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userData?.user?.id, router]);

  return (
    <AccountContext.Provider
      value={{
        accounts,
        setAccounts,
        logout,
        logoutAll,
        swapAccount,
        removeAccount,
        ogAccount,
        setOgAccount,
        removeOgAccount,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
};
