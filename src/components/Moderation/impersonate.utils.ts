import { showNotification, updateNotification } from '@mantine/notifications';
import { ogAccountKey } from '~/components/CivitaiWrapped/AccountProvider';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';
import { impersonateEndpoint } from '~/shared/constants/auth.constants';
import { QS } from '~/utils/qs';

type OgAccount = { id: number; username: string };

type ImpersonateUserArgs = {
  userId: number;
  username?: string | null;
  currentUser: { id: number; username?: string | null };
  swapAccount: (token: EncryptedDataSchema, callbackUrl?: string) => Promise<void>;
  setOgAccount: (og: OgAccount) => void;
  callbackUrl?: string;
};

function readExistingOgFromStorage(): OgAccount | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ogAccountKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OgAccount | null;
    if (parsed && typeof parsed.id === 'number' && typeof parsed.username === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function persistOgAccount(setOgAccount: (og: OgAccount) => void, og: OgAccount) {
  setOgAccount(og);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ogAccountKey, JSON.stringify(og));
    } catch {
      // localStorage may be blocked; setOgAccount still queues a state write
    }
  }
}

export async function impersonateUser({
  userId,
  username,
  currentUser,
  swapAccount,
  setOgAccount,
  callbackUrl,
}: ImpersonateUserArgs): Promise<boolean> {
  if (userId === currentUser.id) return false;

  const notificationId = `impersonate-${userId}`;
  showNotification({
    id: notificationId,
    loading: true,
    autoClose: false,
    title: 'Switching accounts...',
    message: `-> ${username ?? userId} (${userId})`,
  });

  const tokenResp = await fetch(`${impersonateEndpoint}?${QS.stringify({ userId })}`);
  if (!tokenResp.ok) {
    const errMsg = await tokenResp.text();
    updateNotification({
      id: notificationId,
      color: 'red',
      title: 'Failed to switch',
      message: errMsg,
    });
    return false;
  }

  const { token }: { token: EncryptedDataSchema } = await tokenResp.json();

  // Preserve the original mod as the restore point across chained impersonations.
  // Only write a new og marker when none exists yet.
  const existingOg = readExistingOgFromStorage();
  if (!existingOg) {
    persistOgAccount(setOgAccount, {
      id: currentUser.id,
      username: currentUser.username ?? '(unk)',
    });
  }

  await swapAccount(token, callbackUrl);
  return true;
}
