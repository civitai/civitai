import { describe, expect, it } from 'vitest';
import { serviceHoldButtonProps } from '~/components/CreatorShop/Services/creator-service.util';

describe('serviceHoldButtonProps', () => {
  it('uses the short label and keeps the full hold text as the accessible name', () => {
    const props = serviceHoldButtonProps(2500);
    expect(props.label).toBe('Hold and send request');
    expect(props['aria-label']).toBe('Hold 2,500 Buzz and send request');
  });

  it('never places the hold on the back of a Buzz purchase', () => {
    expect(serviceHoldButtonProps(2500).performTransactionOnPurchase).toBe(false);
  });
});
