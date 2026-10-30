import {
  abuseReportInput,
  MAX_FINDINGS_PER_REPORT,
  MAX_REASON_LENGTH,
  type AbuseReportInput,
} from '@civitai/moderation';
import { describe, expect, it } from 'vitest';
import type { LinkedAccountReviewConfig } from '../config';
import type { FlowEdge, SignIn } from '../groups';
import type { LinkedAccountReader, Standing } from '../read';
import { failUnlessRan, runLinkedAccountReview, type FiledStore } from '../run';

// Synthetic values throughout; none are the production configuration.
const CONFIG: LinkedAccountReviewConfig = {
  mode: 'file',
  flowDays: 10,
  linkDays: 60,
  stickerPairMin: 2,
  buzzSenderMin: 150,
  buzzEdgeShare: 0.25,
  buzzAccountTypes: ['alpha'],
  ipAccountCap: 4,
  minSharedIps: 3,
  share: 0.7,
  stickerFloor: 30,
  buzzFloor: 1_000,
  refileDays: 14,
  controlUserIds: [101, 102, 103, 104],
};

const [A, B, C, D] = CONFIG.controlUserIds;
const [E, F] = [301, 302];

const edge = (from: number, to: number, amount: number, senderTotal: number): FlowEdge => ({
  from,
  to,
  amount,
  senderTotal,
});
const shares = (a: number, b: number, ips: string[]): SignIn[] =>
  ips.flatMap((ip) => [
    { userId: a, ip, ipAccounts: 2 },
    { userId: b, ip, ipAccounts: 2 },
  ]);

function reader({
  standings = [] as Standing[],
  excluded = [] as number[],
} = {}): LinkedAccountReader {
  return {
    flows: async () => ({
      stickers: [],
      buzz: [
        edge(A, C, 1_000, 1_600),
        edge(A, B, 500, 1_600),
        edge(B, D, 1_200, 1_250),
        edge(E, F, 2_000, 2_000),
      ],
    }),
    signIns: async () => [
      ...shares(A, C, ['a1', 'a2', 'a3']),
      ...shares(A, B, ['b1', 'b2', 'b3']),
      ...shares(B, D, ['c1', 'c2', 'c3']),
      ...shares(E, F, ['d1', 'd2', 'd3']),
    ],
    standings: async (ids) => standings.filter((s) => ids.includes(s.userId)),
    excluded: async (ids) => excluded.filter((id) => ids.includes(id)),
  };
}

function memoryFiled(
  initial: Record<string, string> = {}
): FiledStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (sigs) => new Map(sigs.filter((s) => data.has(s)).map((s) => [s, data.get(s)!])),
    set: async (entries) => entries.forEach(([k, v]) => data.set(k, v)),
  };
}

const NOW = new Date('2026-11-02T13:00:00Z');

async function run({
  config = CONFIG as Partial<LinkedAccountReviewConfig> | null,
  read = reader(),
  filed = memoryFiled(),
  send = undefined as ((r: AbuseReportInput) => Promise<void>) | undefined,
} = {}) {
  const reports: AbuseReportInput[] = [];
  const result = await runLinkedAccountReview({
    readConfig: async () => (config === null ? null : JSON.stringify({ ...CONFIG, ...config })),
    reader: read,
    filed,
    sendReport: send ?? (async (r) => void reports.push(r)),
    now: () => NOW,
    log: () => undefined,
  });
  return { result, reports, filed };
}

describe('runLinkedAccountReview', () => {
  it('files each group as unactioned findings sharing one group key', async () => {
    const { reports } = await run();
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(() => abuseReportInput.parse(report)).not.toThrow();
    expect(report.requireGroupKey).toBe(true);
    expect(report.findings[0].reason).toContain(`${CONFIG.flowDays}-day`);
    expect(report.findings.every((f) => f.actioned === false && f.action == null)).toBe(true);

    const byGroup = new Map<string, number[]>();
    for (const f of report.findings)
      byGroup.set(f.groupKey!, [...(byGroup.get(f.groupKey!) ?? []), f.userId]);
    expect([...byGroup.values()].map((ids) => ids.sort())).toEqual(
      expect.arrayContaining([
        [A, B, C, D],
        [E, F],
      ])
    );
    expect(report.counters).toMatchObject({ control_grouped: 1, groups_due: 2 });
  });

  it('reads the control before skipping groups already excluded', async () => {
    const { reports, result } = await run({ read: reader({ excluded: [A, B, C, D] }) });
    expect(result).toMatchObject({ control: 'grouped' });
    expect(reports[0].counters).toMatchObject({ control_grouped: 1, skipped_all_excluded: 1 });
    expect(reports[0].findings.map((f) => f.userId).sort()).toEqual([E, F]);
  });

  it('keeps a group whose senders are excluded while its receivers are not', async () => {
    const { reports } = await run({ read: reader({ excluded: [A, B] }) });
    expect(reports[0].counters).toMatchObject({ skipped_all_excluded: 0 });
    expect(reports[0].findings.map((f) => f.userId).sort()).toEqual([A, B, C, D, E, F]);
  });

  it('treats a repeated control id as one account', async () => {
    const { result } = await run({ config: { controlUserIds: [A, A, B, C, D] } });
    expect(result).toMatchObject({ control: 'grouped' });
  });

  it('dry run sends counters only and remembers nothing', async () => {
    const { reports, filed } = await run({ config: { mode: 'dry-run' } });
    expect(reports[0].findings).toEqual([]);
    expect(reports[0].counters).toMatchObject({ dry_run: 1, groups_due: 2, findings_due: 6 });
    expect(filed.data.size).toBe(0);
  });

  it('does not refile an unchanged group inside the refile window', async () => {
    const first = await run();
    const second = await run({ filed: first.filed });
    expect(second.reports[0].findings).toEqual([]);
    expect(second.reports[0].counters).toMatchObject({ skipped_recently_filed: 2 });
  });

  it('refiles once the window has passed', async () => {
    const old = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const { reports } = await run({
      filed: memoryFiled({ [`${A},${B},${C},${D}`]: old, [`${E},${F}`]: old }),
    });
    expect(reports[0].findings).toHaveLength(6);
  });

  it('puts a group with a current standing ahead of one without', async () => {
    const lead = async (standings: Standing[]) => {
      const { reports } = await run({ read: reader({ standings }) });
      return [...reports[0].findings].sort((a, b) => b.confidence - a.confidence)[0];
    };
    expect((await lead([])).groupKey).toBe(
      (await run()).reports[0].findings.find((f) => f.userId === E)?.groupKey
    );

    const standings = [{ userId: D, leaderboardId: 'board-x', position: 7 }];
    expect([A, B]).toContain((await lead(standings)).userId);
    const { reports } = await run({ read: reader({ standings }) });
    expect(reports[0].findings.find((f) => f.userId === D)?.reason).toContain('#7 on board-x');
  });

  it('files nothing when the config is missing or invalid', async () => {
    for (const config of [null, { share: 2 }]) {
      const { reports, result } = await run({ config });
      expect(result.status).toBe('not-configured');
      expect(reports).toEqual([]);
    }
  });

  it.each([
    ['split', [A, B, C, D, E]],
    ['missing', [9001, 9002]],
    ['unset', []],
    ['unset', undefined],
  ])('files nothing in file mode when the control is %s', async (state, controlUserIds) => {
    const filed = memoryFiled();
    const { result, reports } = await run({ config: { controlUserIds }, filed });
    expect(result).toMatchObject({ status: 'control-failed', control: state });
    expect(reports).toEqual([]);
    expect(filed.data.size).toBe(0);
  });

  it('fails the job when it filed nothing or could not run', async () => {
    const failed = await run({ config: { controlUserIds: [] } });
    expect(() => failUnlessRan(failed.result)).toThrow('control unset');
    const unconfigured = await run({ config: null });
    expect(() => failUnlessRan(unconfigured.result)).toThrow('not-configured');
    const dry = await run({ config: { mode: 'dry-run', controlUserIds: [] } });
    expect(failUnlessRan(dry.result)).toMatchObject({ status: 'dry-run' });
  });

  it('still reports the control state on a dry run', async () => {
    const { result, reports } = await run({
      config: { mode: 'dry-run', controlUserIds: [9001, 9002] },
    });
    expect(result).toMatchObject({ status: 'dry-run', control: 'missing' });
    expect(reports[0].counters).toMatchObject({ control_grouped: 0, control_missing: 1 });
  });

  it('remembers nothing when the report is refused', async () => {
    const filed = memoryFiled();
    const send = async () => {
      throw new Error('refused');
    };
    await expect(run({ filed, send })).rejects.toThrow('refused');
    expect(filed.data.size).toBe(0);
  });

  it('files the groups that fit when one group can never fit in a report', async () => {
    const star = (hub: number, size: number) => {
      const spokes = Array.from({ length: size - 1 }, (_, i) => hub + 1 + i);
      return {
        buzz: spokes.map((s) => edge(hub, s, 10, 10 * spokes.length)),
        signIns: spokes.flatMap((s) => shares(hub, s, [`${s}-1`, `${s}-2`, `${s}-3`])),
      };
    };
    const huge = star(100_000, MAX_FINDINGS_PER_REPORT + 1);
    const big = star(200_000, 400);
    const read: LinkedAccountReader = {
      ...reader(),
      flows: async () => ({
        stickers: [],
        buzz: [...huge.buzz, ...big.buzz, edge(E, F, 2_000, 2_000)],
      }),
      signIns: async () => [...huge.signIns, ...big.signIns, ...shares(E, F, ['d1', 'd2', 'd3'])],
    };

    const filed = memoryFiled();
    const { reports } = await run({ read, filed, config: { controlUserIds: [E, F] } });
    const [report] = reports;
    expect(() => abuseReportInput.parse(report)).not.toThrow();
    expect(report.counters).toMatchObject({
      groups_too_large: 1,
      skipped_over_cap: 1,
      groups_due: 2,
    });
    expect(report.findings).toHaveLength(400 + 2);
    expect(Math.max(...report.findings.map((f) => f.reason.length))).toBeLessThanOrEqual(
      MAX_REASON_LENGTH
    );
    expect([...filed.data.keys()].map((sig) => sig.split(',').length).sort()).toEqual([2, 400]);
    const hub = report.findings.find((f) => f.userId === 200_000)!;
    expect(hub.reason).toContain('-day Buzz to group: 3,990 of 3,990');
    expect(hub.reason).toContain('+374 more');
  });
});
