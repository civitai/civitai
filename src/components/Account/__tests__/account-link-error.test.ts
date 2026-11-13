import { describe, expect, it } from 'vitest';
import { accountLinkErrorCopy } from '~/components/Account/account-link-error';

describe('accountLinkErrorCopy', () => {
  it('says the account belongs to someone else only for AccountNotLinked', () => {
    expect(accountLinkErrorCopy('AccountNotLinked')?.title).toBe('Account not linked');
    expect(accountLinkErrorCopy('AccountNotLinked')?.body).toMatch(/already connected to another/);
  });

  it.each(['AccessDenied', 'OAuthCallback', 'anything-else'])(
    'shows a retry message for %s',
    (code) => {
      const copy = accountLinkErrorCopy(code);
      expect(copy?.title).toBe("Couldn't connect account");
      expect(copy?.body).not.toMatch(/already connected to another/);
    }
  );

  it('shows nothing without an error', () => {
    expect(accountLinkErrorCopy(undefined)).toBeNull();
    expect(accountLinkErrorCopy('')).toBeNull();
  });
});
