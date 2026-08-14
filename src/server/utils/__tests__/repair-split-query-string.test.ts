import type { NextApiRequest } from 'next';
import { describe, expect, it } from 'vitest';
import { repairSplitQueryString } from '~/server/utils/request-helpers';

/**
 * `repairSplitQueryString` rejoins a query a client split with a second `?`.
 *
 * The shape under test is what a caller produces by appending the documented
 * `?type=…&format=…` / `?token=…` suffix to a `downloadUrl` that already carries
 * `?fileId=<id>`. Every assertion below names what the caller loses without the
 * repair, because a revert makes each one report a swallowed param rather than
 * a bare falsy.
 */

function makeReq(url: string, query: NextApiRequest['query']) {
  return { url, query } as NextApiRequest;
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

  it('treats an encoded %3F as data, not as a separator', () => {
    const req = makeReq('/api/download/models/1?fp=fp%3F16?type=Model', {
      modelVersionId: '1',
      fp: 'fp?16',
    });

    repairSplitQueryString(req);

    expect(req.query.fp, 'a percent-encoded ? is a value the client meant to send').toBe('fp?16');
    expect(req.query.type).toBe('Model');
  });

  it('never lets a repaired param overwrite a path param', () => {
    // The route resolves `modelVersionId` from the path. A repair that let the
    // query win would re-point the request at a different resource.
    const req = makeReq('/api/download/models/568485?fileId=1?modelVersionId=999', {
      modelVersionId: '568485',
      fileId: '1?modelVersionId=999',
    });

    repairSplitQueryString(req);

    expect(req.query.modelVersionId).toBe('568485');
    expect(req.query.fileId).toBe('1');
  });

  it('keeps repeated params as an array, matching how the query was parsed', () => {
    const req = makeReq('/api/download/models/1?fileId=2?type=Model&type=Config', {
      modelVersionId: '1',
      fileId: '2?type=Model',
      type: 'Config',
    });

    repairSplitQueryString(req);

    expect(req.query.type).toEqual(['Model', 'Config']);
  });
});
