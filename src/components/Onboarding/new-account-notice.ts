// Accounts created in this window see a note on the Terms step about signing in another way than last time.
export const NEW_ACCOUNT_NOTICE_START = new Date('2026-11-18T13:50:00Z');
export const NEW_ACCOUNT_NOTICE_END = new Date('2026-12-02T13:50:00Z');

export const NEW_ACCOUNT_HELP_URL =
  'https://education.civitai.com/signed-in-and-your-account-looks-empty/?utm_source=onboarding&utm_medium=notice';

const ADD_ACCOUNT_KEY = 'civitai:adding-account';
const ADD_ACCOUNT_TTL_MS = 60 * 60 * 1000;

/** Reads only the account's own creation time: never whether any other account exists. */
export function shouldShowNewAccountNotice({
  createdAt,
  impersonated,
  addingAccount,
}: {
  createdAt?: Date | string | null;
  impersonated: boolean;
  addingAccount: boolean;
}): boolean {
  if (impersonated || addingAccount) return false;
  // A missing or unreadable time is NaN, which no comparison passes.
  const created = new Date(createdAt ?? NaN).getTime();
  return (
    created >= NEW_ACCOUNT_NOTICE_START.getTime() && created < NEW_ACCOUNT_NOTICE_END.getTime()
  );
}

/** Set when this tab starts signing in to an additional account; the hub round trip keeps sessionStorage. */
export function markAddAccountFlow() {
  try {
    window.sessionStorage.setItem(ADD_ACCOUNT_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: the notice may show for the added account.
  }
}

export function isAddAccountFlow(): boolean {
  try {
    const startedAt = Number(window.sessionStorage.getItem(ADD_ACCOUNT_KEY));
    return !!startedAt && Date.now() - startedAt < ADD_ACCOUNT_TTL_MS;
  } catch {
    return false;
  }
}
