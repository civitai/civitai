import { describe, expect, it } from 'vitest';
import {
  classifyResourceFileError,
  detectGraphFormat,
  processResourceEntries,
  resolveGetResourceFileRequest,
  resourceFileError,
  type RawResourceEntry,
  type ResourceFileCaps,
} from './resourceFileParse';

function entry(
  path: string,
  text: string,
  declaredSize?: number
): RawResourceEntry & {
  reads: number[];
} {
  const bytes = new TextEncoder().encode(text);
  const reads: number[] = [];
  return {
    path,
    declaredSize,
    reads,
    read: async (limit) => {
      reads.push(limit);
      const n = Math.min(bytes.byteLength, limit);
      return {
        text: new TextDecoder().decode(bytes.subarray(0, n)),
        bytes: n,
        hitLimit: bytes.byteLength >= limit,
      };
    },
  };
}

const caps = (over: Partial<ResourceFileCaps> = {}): ResourceFileCaps => ({
  maxEntries: 5,
  perEntryBytes: 1000,
  totalBytes: 5000,
  ...over,
});

describe('detectGraphFormat', () => {
  it('api: every top-level value is a node with class_type and inputs', () => {
    expect(detectGraphFormat({ '1': { class_type: 'A', inputs: {} } })).toBe('api');
  });
  it('not api when one value lacks inputs', () => {
    expect(
      detectGraphFormat({ '1': { class_type: 'A', inputs: {} }, '2': { class_type: 'B' } })
    ).toBe('unknown');
  });
  it('ui: a nodes array', () => {
    expect(detectGraphFormat({ nodes: [], links: [] })).toBe('ui');
  });
  it('unknown: an empty object, an array, a scalar, or nodes that is not an array', () => {
    expect(detectGraphFormat({})).toBe('unknown');
    expect(detectGraphFormat([{ class_type: 'A', inputs: {} }])).toBe('unknown');
    expect(detectGraphFormat('x')).toBe('unknown');
    expect(detectGraphFormat({ nodes: {} })).toBe('unknown');
  });
});

describe('classifyResourceFileError', () => {
  it.each([
    ['NOT_FOUND', 'not-found'],
    ['FORBIDDEN', 'forbidden'],
    ['UNAUTHORIZED', 'unauthorized'],
    ['TOO_MANY_REQUESTS', 'rate-limited'],
    ['PAYLOAD_TOO_LARGE', 'too-large'],
  ])('maps tRPC %s to %s', (code, expected) => {
    expect(classifyResourceFileError({ data: { code } })).toBe(expected);
  });
  it('a host-tagged error wins', () => {
    expect(classifyResourceFileError(resourceFileError('too-large'))).toBe('too-large');
  });
  it('anything else is parse-failed', () => {
    expect(classifyResourceFileError({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(
      'parse-failed'
    );
    expect(classifyResourceFileError(new Error('boom'))).toBe('parse-failed');
    expect(classifyResourceFileError(undefined)).toBe('parse-failed');
  });
});

describe('resolveGetResourceFileRequest', () => {
  it('accepts an optional fileId and coerces numeric strings', () => {
    expect(resolveGetResourceFileRequest({ requestId: 'r', modelVersionId: '9' })).toEqual({
      requestId: 'r',
      modelVersionId: 9,
    });
    expect(resolveGetResourceFileRequest({ requestId: 'r', modelVersionId: 9, fileId: 4 })).toEqual(
      { requestId: 'r', modelVersionId: 9, fileId: 4 }
    );
  });
  it('drops a missing requestId, a bad modelVersionId, or a bad fileId', () => {
    expect(resolveGetResourceFileRequest({ modelVersionId: 9 })).toBeNull();
    expect(resolveGetResourceFileRequest({ requestId: 'r', modelVersionId: 0 })).toBeNull();
    expect(
      resolveGetResourceFileRequest({ requestId: 'r', modelVersionId: 9, fileId: 1.5 })
    ).toBeNull();
  });
});

describe('processResourceEntries', () => {
  it('reads only JSON entries, and tolerates a corrupt one', async () => {
    const png = entry('a.png', 'x');
    const res = await processResourceEntries(
      [png, entry('bad.json', '{'), entry('ok.json', '{"nodes":[]}')],
      caps()
    );
    expect(png.reads).toEqual([]);
    expect(res).toEqual({
      entries: [{ path: 'ok.json', format: 'ui', graph: { nodes: [] } }],
      truncated: true,
    });
  });

  it('an entry exactly at the per-entry cap is kept; one byte over is skipped', async () => {
    const at = `"${'a'.repeat(998)}"`; // 1000 bytes
    const over = `"${'a'.repeat(999)}"`; // 1001 bytes
    expect((await processResourceEntries([entry('at.json', at)], caps())).truncated).toBe(false);
    const res = await processResourceEntries(
      [entry('over.json', over), entry('at.json', at)],
      caps()
    );
    expect(res.entries.map((e) => e.path)).toEqual(['at.json']);
    expect(res.truncated).toBe(true);
  });

  it('skips an entry whose declared size is over the cap without reading it', async () => {
    const big = entry('big.json', '{}', 5000);
    const res = await processResourceEntries([big, entry('ok.json', '{}')], caps());
    expect(big.reads).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  it('stops at the total inflate budget', async () => {
    const e = (n: string) => entry(`${n}.json`, `"${'a'.repeat(598)}"`); // 600 bytes
    const res = await processResourceEntries([e('a'), e('b'), e('c')], caps({ totalBytes: 1300 }));
    expect(res.entries.map((x) => x.path)).toEqual(['a.json', 'b.json']);
    expect(res.truncated).toBe(true);
  });

  it('keeps at most maxEntries and flags the rest', async () => {
    const list = Array.from({ length: 7 }, (_, i) => entry(`${i}.json`, '{}'));
    const res = await processResourceEntries(list, caps({ maxEntries: 3 }));
    expect(res.entries).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(list[3].reads).toEqual([]);
  });

  it('nothing returnable: too-large when the size caps removed it, else parse-failed', async () => {
    await expect(
      processResourceEntries([entry('big.json', '{}', 99_999)], caps())
    ).rejects.toMatchObject({ resourceFileError: 'too-large' });
    await expect(
      processResourceEntries([entry('a.txt', '{}'), entry('b.json', 'nope')], caps())
    ).rejects.toMatchObject({ resourceFileError: 'parse-failed' });
  });
});
