import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wrapper only plumbs session and flags into `resolver`; the redirect decision is the resolver's.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (config: unknown) => config,
}));
const { v1Live } = vi.hoisted(() => ({ v1Live: vi.fn(async () => true) }));
vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: v1Live }));

type Resolver = (args: { features: { newOrderGame: boolean } }) => Promise<unknown>;
const page = (await import('~/pages/games/knights-of-new-order')) as unknown as {
  getServerSideProps: { resolver: Resolver };
};
const visit = (newOrderGame: boolean) =>
  page.getServerSideProps.resolver({ features: { newOrderGame } });

beforeEach(() => v1Live.mockResolvedValue(true));

describe('/games/knights-of-new-order', () => {
  it('sends a domain the game is not offered on to the home page', async () => {
    expect(await visit(false)).toEqual({ redirect: { destination: '/', permanent: false } });
  });

  it('sends everyone to the Knights app once v1 is retired', async () => {
    v1Live.mockResolvedValue(false);

    expect(await visit(true)).toEqual({
      redirect: { destination: 'https://knights.civitai.com', permanent: false },
    });
  });

  it('renders the old game while v1 is live', async () => {
    expect(await visit(true)).toBeUndefined();
  });
});
