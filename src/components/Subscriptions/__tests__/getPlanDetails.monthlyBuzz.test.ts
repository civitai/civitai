import type { ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

// The monthly Buzz line names the colour the plan pays out, whichever site it is shown on.

const onCom = { isGreen: true } as FeatureAccess;
const onRed = { isGreen: false } as FeatureAccess;

const textOf = (node: ReactNode): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
};

const monthlyLine = (metadata: Record<string, unknown>, features: FeatureAccess) => {
  const [line] = getPlanDetails(
    { name: 'Bronze Tier', metadata: { tier: 'bronze', ...metadata } as never },
    features
  ).benefits;
  return { color: line.iconColor, text: textOf(line.content).replace(/\s+/g, ' ').trim() };
};

describe('getPlanDetails monthly Buzz line', () => {
  it('a green plan reads Green Buzz on .red', () => {
    expect(monthlyLine({ buzzType: 'green', monthlyBuzz: 10000 }, onRed)).toEqual({
      color: 'green',
      text: '10,000 Green Buzz per month',
    });
  });

  it('a yellow plan reads Yellow Buzz on .com', () => {
    expect(monthlyLine({ buzzType: 'yellow', monthlyBuzz: 25000 }, onCom)).toEqual({
      color: 'yellow',
      text: '25,000 Yellow Buzz per month',
    });
  });

  it.each([
    ['.com', onCom],
    ['.red', onRed],
  ])(
    'a plan with no buzzType reads Yellow Buzz, the colour it is paid in, on %s',
    (_, features) => {
      expect(monthlyLine({ monthlyBuzz: 10000 }, features)).toEqual({
        color: 'yellow',
        text: '10,000 Yellow Buzz per month',
      });
    }
  );

  it('a Buzz-bought plan, sold on both sites, names the site colour', () => {
    expect(monthlyLine({ buzzPurchase: true, monthlyBuzz: 0 }, onCom)).toEqual({
      color: 'gray',
      text: '0 Green Buzz per month',
    });
  });

  it('a plan with no monthly Buzz stays grey', () => {
    expect(monthlyLine({ buzzType: 'green', monthlyBuzz: 0 }, onRed).color).toBe('gray');
  });
});
