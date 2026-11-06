import { describe, expect, it } from 'vitest';
import { cryptoDepositToast } from '~/components/Signals/crypto-deposit-toast';

describe('cryptoDepositToast', () => {
  it.each(['confirming', 'confirmed', 'sending'])(
    'tells the user a %s deposit was detected',
    (status) => {
      expect(cryptoDepositToast(status, 'BTC')).toMatchObject({ title: 'Crypto Deposit Detected' });
    }
  );

  it('tells the user how much Buzz a finished deposit credited', () => {
    expect(cryptoDepositToast('finished', 'USDC', 4.5)).toMatchObject({
      title: 'Crypto Deposit Complete',
      message: 'You received 4,500 Buzz from your USDC deposit.',
    });
  });

  it.each(['waiting', 'failed', 'held', 'buzz_failed'])('shows no toast for %s', (status) => {
    expect(cryptoDepositToast(status, 'BTC')).toBeNull();
  });
});
