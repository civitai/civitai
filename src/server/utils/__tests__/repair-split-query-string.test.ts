import type { NextApiRequest } from 'next';
import { describe, expect, it } from 'vitest';
import { repairSplitQueryString } from '~/server/utils/request-helpers';

/**
 * `repairSplitQueryString` rejoins a query a client split with a second `?`.
 *
 * The shape under test is what a caller produces by appending the documented
 * `?type=…&format=…` / `?token=…` suffix to a `downloadUrl` that already carries
 * `?fileId=<id>`. Every assertion names what the caller loses without the
 * repair, because a revert makes each one report a swallowed param rather than
 * a bare falsy.
 *
 * `query` fixtures are what Next itself would hand the route for the given url:
 * the query string parsed with `URLSearchParams`, then the path params spread
 * OVER it (`next-server.ts` — params win on a collision).
 */

/**
 * Every fixture url is normalised the way `normalizeCdnUrl` does before an API
 * route runs, so the stray `?` and the `=` behind it reach the repair
 * percent-encoded. Passing the raw url here instead is what let civitai#3931
 * ship green against a shape prod never produces.
 */
function makeReq(url: string, query: NextApiRequest['query']) {
  const [pathname, search] = url.split(/\?(.*)/s);
  return {
    url: search ? `${pathname}?${new URLSearchParams(search)}` : pathname,
    query,
  } as NextApiRequest;
}

describe('repairSplitQueryString', () => {
  it('splits the reported shape back into its params', () => {
    const req = makeReq(
      '/api/download/models/568485?fileId=484398?type=Model&format=SafeTensor&token=abc',
      { modelVersionId: '568485', fileId: '484398?type=Model', format: 'SafeTensor', token: 'abc' }
    );

    expect(repairSplitQueryString(req)).toBe(true);
    expect(req.query.fileId, 'fileId still carries the swallowed `?type=Model`').toBe('484398');
    expect(req.query.type, 'the param after the stray `?` never reached the handler').toBe('Model');
    expect(req.query.format).toBe('SafeTensor');
    expect(req.query.token).toBe('abc');
  });

  it('repairs req.url too, which is where API-key auth reads ?token=', () => {
    const req = makeReq('/api/download/models/501240?fileId=418901?token=secret', {
      modelVersionId: '501240',
      fileId: '418901?token=secret',
    });

    repairSplitQueryString(req);

    const parsed = new URL(req.url as string, 'https://civitai.com');
    expect(
      parsed.searchParams.get('token'),
      'auth reads the token off req.url — an unrepaired url authenticates nobody'
    ).toBe('secret');
    expect(parsed.searchParams.get('fileId')).toBe('418901');
  });

  it('leaves a well-formed request untouched', () => {
    const url = '/api/download/models/501240?fileId=418901&token=abc';
    const req = makeReq(url, { modelVersionId: '501240', fileId: '418901', token: 'abc' });

    expect(repairSplitQueryString(req)).toBe(false);
    expect(req.url).toBe(url);
    expect(req.query).toEqual({ modelVersionId: '501240', fileId: '418901', token: 'abc' });
  });

  it('leaves a request with no query string untouched', () => {
    const req = makeReq('/api/download/models/501240', { modelVersionId: '501240' });

    expect(repairSplitQueryString(req)).toBe(false);
    expect(req.url).toBe('/api/download/models/501240');
  });

  it('rejoins every stray `?`, not just the first', () => {
    const req = makeReq('/api/download/models/1?fileId=2?type=Model?format=SafeTensor', {
      modelVersionId: '1',
      fileId: '2?type=Model?format=SafeTensor',
    });

    repairSplitQueryString(req);

    expect(req.query.fileId).toBe('2');
    expect(req.query.type).toBe('Model');
    expect(req.query.format).toBe('SafeTensor');
  });

  it('splits the `?` that is a separator while keeping the one that is data', () => {
    const req = makeReq('/api/download/models/1?fp=fp%3F16?type=Model', {
      modelVersionId: '1',
      fp: 'fp?16?type=Model',
    });

    repairSplitQueryString(req);

    expect(req.query.fp, 'a ? that opens no param is a value the client meant to send').toBe(
      'fp?16'
    );
    expect(req.query.type).toBe('Model');
  });

  it('repairs the url shape Next actually hands the route', () => {
    // The literal encoding here is what `normalizeCdnUrl` produces from
    // `?fileId=1541606?type=Model&format=SafeTensor`. A repair that keys on a raw
    // `?` in req.url finds none and bails, which is how the 400s survived #3931.
    const req = makeReq(
      '/api/download/models/1641161?fileId=1541606%3Ftype%3DModel&format=SafeTensor',
      { modelVersionId: '1641161', fileId: '1541606?type=Model', format: 'SafeTensor' }
    );

    expect(repairSplitQueryString(req), 'the encoded separator was read as data').toBe(true);
    expect(req.query.fileId, 'fileId still parses as NaN, so the route answers 400').toBe('1541606');
    expect(req.query.type).toBe('Model');
    expect(req.query.format).toBe('SafeTensor');
  });
});

describe('repairSplitQueryString — what it refuses to touch', () => {
  it('leaves a raw `?` that does not open a new param inside its value', () => {
    // RFC 3986 §3.4 permits a raw `?` in a query value. Splitting on it would
    // truncate the token and hand the route a phantom `cd` param.
    const req = makeReq('/api/download/models/1?token=ab?cd', {
      modelVersionId: '1',
      token: 'ab?cd',
    });

    expect(repairSplitQueryString(req)).toBe(false);
    expect(req.query.token).toBe('ab?cd');
    expect(req.query).not.toHaveProperty('cd');
  });

  it('never lets a repaired param overwrite the path param it collides with', () => {
    // The path is what a user reads and a log records. `modelVersionId` here is
    // BOTH the route's path param and the first query key, which is the
    // arrangement that defeats a naive "keys not in the query string are path
    // params" guard — the query key deletes itself from that set.
    const req = makeReq('/api/download/models/568485?modelVersionId=999?fileId=2', {
      modelVersionId: '568485',
      fileId: '2',
    });

    repairSplitQueryString(req);

    expect(
      req.query.modelVersionId,
      'the repair re-pointed the request at another model version'
    ).toBe('568485');
  });

  it('never replaces a param that already arrived intact', () => {
    const req = makeReq('/api/download/models/1?fileId=2?type=Model&type=Config', {
      modelVersionId: '1',
      fileId: '2?type=Model',
      type: 'Config',
    });

    repairSplitQueryString(req);

    expect(req.query.fileId).toBe('2');
    expect(req.query.type, 'a value Next parsed cleanly was overwritten by the repair').toBe(
      'Config'
    );
  });
});

describe('repairSplitQueryString — what it leaves behind', () => {
  it('drops the split entry rather than keeping it beside the repair', () => {
    // Here the stray `?` lands inside a KEY, so Next parses `debug?type`. Left
    // in place it reaches everything that iterates req.query, logging included.
    const req = makeReq('/api/download/models/1?debug?type=Model', {
      modelVersionId: '1',
      'debug?type': 'Model',
    });

    repairSplitQueryString(req);

    expect(req.query).not.toHaveProperty('debug?type');
    expect(req.query.type).toBe('Model');
  });

  it('rewrites req.url without empty query segments', () => {
    const req = makeReq('/api/download/models/1?fileId=2?&type=Model', {
      modelVersionId: '1',
      fileId: '2?',
    });

    repairSplitQueryString(req);

    expect(req.url).toBe('/api/download/models/1?fileId=2&type=Model');
  });
});
