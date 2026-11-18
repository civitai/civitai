import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_CSAM_SQL,
  parseArgs,
  run,
  SCRIPT_BASENAME,
  type Deps,
} from '../oneoffs/reconcile-held-media-blocked-hashes';

type Row = { hash: string; reason: string; disabled: boolean };

/**
 * Evaluates the live-set query over rows (oldest first) the way ClickHouse does: with argMax, each
 * hash's newest row decides; without it every row counts.
 */
function liveSet(rows: Row[], query: string) {
  const live = (row: Row) =>
    row.reason === 'CSAM' && (!row.disabled || !query.includes('tupleElement(newest, 2) = false'));
  const newest = new Map<string, Row>();
  for (const row of rows) newest.set(row.hash, row);
  const read = query.includes('argMax(tuple(reason, disabled)') ? [...newest.values()] : rows;
  return [...new Set(read.filter(live).map((row) => row.hash))];
}

function deps(opts: { live: string[]; pg: string[]; counts?: number[] }) {
  const execute = vi.fn(async (_sql: string) => undefined);
  const lines: string[] = [];
  const counts = [...(opts.counts ?? [])];
  const d: Deps = {
    readLive: async () => opts.live,
    readPg: async () => opts.pg,
    readCopied: async () => counts.shift() ?? 0,
    writer: () => ({ execute }),
    log: (line) => lines.push(line),
    sleep: async () => undefined,
  };
  return { d, execute, lines };
}

describe('the live set', () => {
  // Deliberately a SQL-text pin: the same newest-row rule, tie-break and filter as the app's CSAM-entry
  // check (image-moderation-effects.ts csamBlockedHashes, and its main-app twin).
  it('uses the app CSAM-entry rule', () => {
    expect(LIVE_CSAM_SQL).toContain(
      "argMax(tuple(reason, disabled), tuple(created_at, reason = 'CSAM' AND disabled = false)) AS newest"
    );
    expect(LIVE_CSAM_SQL).toContain(
      "WHERE tupleElement(newest, 1) = 'CSAM' AND tupleElement(newest, 2) = false"
    );
    expect(LIVE_CSAM_SQL).toContain(
      "WHERE hash IN (SELECT hash FROM blocked_images WHERE reason = 'CSAM')"
    );
  });

  const rows = (...r: Row[]) => liveSet(r, LIVE_CSAM_SQL);

  it('a live CSAM entry is copied', () => {
    expect(rows({ hash: '1', reason: 'CSAM', disabled: false })).toEqual(['1']);
  });

  it('a CSAM entry a newer row disabled is not', () => {
    expect(
      rows(
        { hash: '1', reason: 'CSAM', disabled: false },
        { hash: '1', reason: 'CSAM', disabled: true }
      )
    ).toEqual([]);
  });

  it('a CSAM entry a newer row of another reason replaced is not', () => {
    expect(
      rows(
        { hash: '1', reason: 'CSAM', disabled: false },
        { hash: '1', reason: 'TOS', disabled: false }
      )
    ).toEqual([]);
  });

  it('a disabled entry re-enabled by a newer CSAM row is', () => {
    expect(
      rows(
        { hash: '1', reason: 'CSAM', disabled: true },
        { hash: '1', reason: 'CSAM', disabled: false }
      )
    ).toEqual(['1']);
  });
});

describe('a run', () => {
  it('a dry run counts and writes nothing, and builds no write client', async () => {
    const [a, b, c, z] = ['-4276845791567733103', '4276845791567733104', '-77', '55'];
    const { d, execute, lines } = deps({ live: [a, b, c], pg: [a, z] });
    const writer = vi.spyOn(d, 'writer');

    const p = await run({ apply: false, expect: null }, d);

    expect(p.missing).toEqual([b, c]);
    expect(p.stale).toBe(1);
    expect(writer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'live in blocklist: 3; in Postgres: 2; to copy: 2; stale in Postgres (left): 1',
      'dry run: nothing written',
    ]);
  });

  it('an apply whose count differs from --expect writes nothing', async () => {
    const { d, execute } = deps({ live: ['1', '2', '3'], pg: ['1'] });

    await expect(run({ apply: true, expect: 3 }, d)).rejects.toThrow('refusing to write: 2');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an apply that matches copies only the missing hashes and reads the replica back', async () => {
    const { d, execute, lines } = deps({ live: ['1', '2', '3'], pg: ['1'], counts: [1, 2] });

    await run({ apply: true, expect: 2 }, d);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain("(2, 'CSAM'), (3, 'CSAM')");
    expect(execute.mock.calls[0][0]).not.toContain("(1, 'CSAM')");
    expect(lines.at(-1)).toBe('replica readback: 2 of 2 copied');
  });

  it('a replica that never reaches the count fails the run', async () => {
    const { d } = deps({ live: ['1', '2'], pg: [], counts: [] });

    await expect(run({ apply: true, expect: 2 }, d)).rejects.toThrow('readback is short');
  });

  it('an empty blocklist read refuses to run', async () => {
    const { d } = deps({ live: [], pg: ['1'] });

    await expect(run({ apply: false, expect: null }, d)).rejects.toThrow('refusing to run');
  });

  it('--apply without --expect is refused', () => {
    expect(() => parseArgs(['node', 's', '--apply'])).toThrow('--apply needs --expect');
    expect(parseArgs(['node', 's', '--apply', '--expect', '0'])).toEqual({
      apply: true,
      expect: 0,
    });
  });

  it('the entrypoint guard names this file', () => {
    expect(path.basename(SCRIPT_BASENAME)).toBe(
      path.basename('scripts/oneoffs/reconcile-held-media-blocked-hashes.ts', '.ts')
    );
  });
});
