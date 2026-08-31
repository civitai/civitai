import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as UserHubService from '~/server/services/user-hub.service';
import { encodeHubId } from '~/server/utils/hub-id';
// The CANONICAL db mock, registered once in `src/__tests__/setup.ts`. A per-file mock
// of `~/server/db/client` is what `no-direct-shared-module-mock` refuses: under
// `--no-isolate` a module instance is per WORKER, so one file's mock poisons every
// later file that never mocked anything.
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `/api/og?type=hub` — the unauthenticated, CDN-cached surface.
 *
 * Two properties, both of which the handler could lose without any other test
 * noticing: the id is the hub's ENCODED key rather than the row's int, and a hub card
 * takes the SHORT cache because a hub's sharing can be revoked.
 *
 * The sibling `og.image-optimizer-sharp.test.ts` deliberately mocks the database down
 * to three models so it touches no fixtures; widening that mock for a hub would spoil
 * what it exists to isolate. Hence a second file.
 */

const { getHubCardData } = vi.hoisted(() => ({ getHubCardData: vi.fn() }));
// Spread the real module rather than replacing it: `og.tsx` imports `image.service`,
// which itself imports `hubBrowsingLevel` and `resolveHubSources` from here. A factory
// listing one export replaces the module for that consumer too, and the day an og path
// reaches either symbol this file fails pointing at the harness, not the behaviour.
vi.mock('~/server/services/user-hub.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHubService>()),
  getHubCardData,
}));

import handler from '~/pages/api/og';

type CapturedRes = NextApiResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
};

function makeRes(): CapturedRes {
  const res = { _status: 200, _headers: {}, _body: undefined } as unknown as CapturedRes;
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.setHeader = vi.fn((k: string, v: string) => {
    res._headers[k.toLowerCase()] = v;
    return res;
  }) as any;
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.end = vi.fn(() => res) as any;
  return res;
}

const render = async (query: Record<string, string>) => {
  const res = makeRes();
  await handler({ method: 'GET', query, headers: {} } as unknown as NextApiRequest, res);
  return res;
};

const HUB_ID = 19;

beforeEach(() => {
  // The control case renders the no-entity FallbackCard, which needs the model read
  // to resolve null rather than hit a database.
  dbMock.dbRead.model.findFirst.mockResolvedValue(null);
  getHubCardData.mockReset();
  getHubCardData.mockResolvedValue({
    name: 'Neat models!',
    description: 'Models I think are neat',
    username: 'ellie',
    sourceCount: 5,
    followerCount: 0,
  });
});

describe('/api/og?type=hub', () => {
  it('renders a card for an ENCODED id', async () => {
    const res = await render({ type: 'hub', id: encodeHubId(HUB_ID) });

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toBe('image/png');
    expect(getHubCardData).toHaveBeenCalledWith(HUB_ID);
  });

  it('refuses a BARE INTEGER without reading the hub', async () => {
    // This endpoint has no session and the ids are dense, so accepting the int makes
    // every public hub's name, description, owner and counts walkable by counting —
    // which is the surface the service comment says is acceptable *because* the id is
    // encoded. `not.toHaveBeenCalled` is the half that matters: a fall-through would
    // still render something and pass a status-only assertion.
    const res = await render({ type: 'hub', id: String(HUB_ID) });

    expect(res._status).toBe(400);
    expect(getHubCardData).not.toHaveBeenCalled();
  });

  it('takes the SHORT cache, because a hub can be un-shared', async () => {
    // The long branch is 7 days. The share dialog tells the owner every link they
    // handed out stops working, and an edge-cached card keeps serving the hub's name,
    // description and owner for a week after they revoke it.
    const res = await render({ type: 'hub', id: encodeHubId(HUB_ID) });

    // Whole value: `toContain('max-age=300')` also matches `s-maxage=300`, so dropping
    // the browser half alone would pass.
    expect(res._headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
  });

  it('still resolves the INT for every other type', async () => {
    // The control. Without it, resolving every type through the hub decoder would pass
    // the two cases above while breaking the six card types that predate hubs.
    const res = await render({ type: 'model', id: '999999999' });

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toBe('image/png');
  });
});
