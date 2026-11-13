import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// Eligibility is behind the services flag: a seller without it who opens the panel to pause or
// remove must not query it, or every load answers 403.

const enabled = vi.hoisted(() => ({ eligibility: [] as unknown[], mine: [] as unknown[] }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: (_: unknown, opts?: { enabled?: boolean }) => {
        enabled.eligibility.push(opts?.enabled);
        return { data: undefined, isLoading: false };
      },
    },
    'creatorService.getMine': {
      useQuery: (_: unknown, opts?: { enabled?: boolean }) => {
        enabled.mine.push(opts?.enabled);
        return { data: undefined, isLoading: false };
      },
    },
  }),
}));

const { useQueryMyServices } = await import(
  '~/components/CreatorShop/Services/creator-service.util'
);

const run = (...args: Parameters<typeof useQueryMyServices>) => {
  const Probe = () => {
    useQueryMyServices(...args);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
};

beforeEach(() => {
  enabled.eligibility = [];
  enabled.mine = [];
});

describe('useQueryMyServices', () => {
  it("lists a seller's services without asking eligibility when they cannot sell", () => {
    run(true, false);
    expect(enabled.mine).toEqual([true]);
    expect(enabled.eligibility).toEqual([false]);
  });

  it('asks both for a seller with the services flag', () => {
    run(true);
    expect(enabled.mine).toEqual([true]);
    expect(enabled.eligibility).toEqual([true]);
  });
});
