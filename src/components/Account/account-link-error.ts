// Copy for the `?error=` the hub's account-link flow returns with. Only AccountNotLinked means the identity
// belongs to another Civitai account; anything else (cancelled consent, a provider refusal) is a retry.
export function accountLinkErrorCopy(error: string | string[] | undefined) {
  if (!error) return null;
  if (error === 'AccountNotLinked')
    return {
      title: 'Account not linked',
      body: 'That account is already connected to another Civitai account. If you want to link it to this account, switch accounts and remove it from the other Civitai account.',
    };
  return {
    title: "Couldn't connect account",
    body: 'The connection was cancelled or the provider could not complete it. Please try again.',
  };
}
