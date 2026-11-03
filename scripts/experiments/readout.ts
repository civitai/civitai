// Experiment readout: users exposed per arm, outcome rates with 95% CIs, each arm against control,
// and a sample-ratio check. Read-only on both stores.
//
// Usage:
//   CLICKHOUSE_HOST=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=... \
//   READOUT_DATABASE_URL=postgres://...replica... \
//   pnpm exec tsx scripts/experiments/readout.ts --exp hatTurfFeedCard \
//     [--event birthday2026] [--since 2026-11-06] [--until 2026-12-01] [--json]
//
// Exit codes: 0 read, 2 sample-ratio mismatch (do not read the results), 1 error.
// The ClickHouse account must be read-only and the Postgres URL should be a replica; the script
// refuses a writable ClickHouse account and sets its Postgres session read-only.
import { createClient } from '@clickhouse/client';
import { Client as PgClient } from 'pg';
import { experiments, type ExperimentKey } from '../../src/shared/constants/experiments.constants';
import {
  moments,
  sampleRatio,
  twoProportion,
  welch,
  wilson,
  type Comparison,
  type Interval,
} from './stats';

export const METRICS = {
  joined: { kind: 'rate', label: 'joined Turf (opt-in)' },
  placedAny: { kind: 'rate', label: 'placed ≥1 hat' },
  placedFromFeed: { kind: 'rate', label: 'placed ≥1 hat from the feed' },
  returned2Days: { kind: 'rate', label: 'placed on 2+ distinct days' },
  placements: { kind: 'mean', label: 'placements per exposed user' },
  inviteDismissed: { kind: 'rate', label: 'dismissed the invite' },
  feedSaved: { kind: 'rate', label: 'saved a placement from the feed' },
  hatCountOpened: { kind: 'rate', label: 'opened the hat-count row' },
  hidAllHats: { kind: 'rate', label: 'turned on hide-all-hats' },
} as const;
export type MetricKey = keyof typeof METRICS;

type ReadoutPlan = {
  primary: MetricKey;
  secondary: MetricKey[];
  guardrail: MetricKey[];
  /** Expected share of users per arm, in `experiments[key].variants` order. */
  split: number[];
  readOn: string;
};

// Pre-registered with the Team Hats lead on 2026-11-03. Change a plan only before its experiment
// starts; a primary metric chosen after looking is not a test.
export const READOUT_PLANS: Record<ExperimentKey, ReadoutPlan> = {
  hatTurfImageDetail: {
    primary: 'joined',
    secondary: ['returned2Days', 'placements', 'inviteDismissed'],
    guardrail: ['hidAllHats'],
    split: [0.5, 0.5],
    readOn: '2026-11-24',
  },
  hatTurfFeedCard: {
    primary: 'placedFromFeed',
    secondary: ['returned2Days', 'placements', 'feedSaved', 'hatCountOpened'],
    guardrail: ['hidAllHats'],
    split: [0.5, 0.5],
    readOn: '2026-11-24',
  },
};

export const SRM_ALPHA = 0.001;

export type ExposedUser = {
  userId: number;
  variant: string;
  nVariants: number;
  outcomes: Record<MetricKey, number>;
};

type ArmMetric =
  | { kind: 'rate'; successes: number; n: number; rate: number; ci: Interval }
  | { kind: 'mean'; n: number; mean: number; ci: Interval };

export type Readout = {
  exp: ExperimentKey;
  interim: boolean;
  arms: { variant: string; users: number; metrics: Record<MetricKey, ArmMetric> }[];
  comparisons: {
    variant: string;
    metric: MetricKey;
    role: 'primary' | 'secondary' | 'guardrail';
    alpha: number;
    result: Comparison;
  }[];
  srm: { statistic: number; p: number; mismatch: boolean };
  contaminatedUsers: number;
};

export function buildReadout(
  exp: ExperimentKey,
  users: readonly ExposedUser[],
  now: Date = new Date()
): Readout {
  const plan = READOUT_PLANS[exp];
  const variants = experiments[exp].variants as readonly string[];
  const control = experiments[exp].defaultVariant;
  // A user seen in two arms broke the stable-assignment guarantee; count them and leave them out.
  const clean = users.filter((u) => u.nVariants === 1);
  const byArm = new Map(variants.map((v) => [v, clean.filter((u) => u.variant === v)]));
  const metricKeys = [plan.primary, ...plan.secondary, ...plan.guardrail];

  const armMetric = (arm: readonly ExposedUser[], metric: MetricKey): ArmMetric => {
    const values = arm.map((u) => u.outcomes[metric]);
    if (METRICS[metric].kind === 'mean') {
      const m = moments(values);
      const half = 1.96 * Math.sqrt(m.variance / Math.max(m.n, 1));
      return {
        kind: 'mean',
        n: m.n,
        mean: m.mean,
        ci: { low: m.mean - half, high: m.mean + half },
      };
    }
    const successes = values.filter((v) => v > 0).length;
    return {
      kind: 'rate',
      successes,
      n: arm.length,
      rate: arm.length ? successes / arm.length : 0,
      ci: wilson(successes, arm.length),
    };
  };

  const arms = variants.map((variant) => {
    const arm = byArm.get(variant) ?? [];
    const metrics = Object.fromEntries(metricKeys.map((m) => [m, armMetric(arm, m)])) as Record<
      MetricKey,
      ArmMetric
    >;
    return { variant, users: arm.length, metrics };
  });

  const controlArm = byArm.get(control) ?? [];
  const role = (m: MetricKey) =>
    m === plan.primary ? 'primary' : plan.guardrail.includes(m) ? 'guardrail' : 'secondary';
  const comparisons = variants
    .filter((v) => v !== control)
    .flatMap((variant) => {
      const arm = byArm.get(variant) ?? [];
      return metricKeys.map((metric) => {
        const r = role(metric);
        const alpha = r === 'secondary' ? 0.05 / plan.secondary.length : 0.05;
        const pick = (xs: readonly ExposedUser[]) => xs.map((u) => u.outcomes[metric]);
        const result =
          METRICS[metric].kind === 'mean'
            ? welch(moments(pick(controlArm)), moments(pick(arm)))
            : twoProportion(
                { successes: pick(controlArm).filter((v) => v > 0).length, n: controlArm.length },
                { successes: pick(arm).filter((v) => v > 0).length, n: arm.length }
              );
        return { variant, metric, role: r, alpha, result };
      });
    });

  const srm = sampleRatio(
    arms.map((a) => a.users),
    plan.split
  );
  return {
    exp,
    interim: now < new Date(`${plan.readOn}T00:00:00Z`),
    arms,
    comparisons,
    srm: { ...srm, mismatch: srm.p < SRM_ALPHA },
    contaminatedUsers: users.length - clean.length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const num = (x: number) => x.toFixed(3);

export function formatReadout(r: Readout, dropped: Record<string, number> = {}): string {
  const lines: string[] = [];
  lines.push(`Experiment ${r.exp}${r.interim ? '  [INTERIM: before the read date]' : ''}`);
  lines.push(
    `Sample ratio: chi2=${num(r.srm.statistic)} p=${r.srm.p.toExponential(2)}${
      r.srm.mismatch ? '  ⛔ SRM: do not read results' : '  ok'
    }`
  );
  lines.push(`Users seen in more than one arm (excluded): ${r.contaminatedUsers}`);
  const droppedText = Object.entries(dropped)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  if (droppedText) lines.push(`Exposed users not randomised (excluded): ${droppedText}`);
  for (const arm of r.arms) {
    lines.push('', `Arm ${arm.variant}: ${arm.users} users`);
    for (const [key, m] of Object.entries(arm.metrics)) {
      const label = METRICS[key as MetricKey].label;
      lines.push(
        m.kind === 'rate'
          ? `  ${label}: ${pct(m.rate)} (${m.successes}/${m.n}) CI ${pct(m.ci.low)}..${pct(
              m.ci.high
            )}`
          : `  ${label}: ${num(m.mean)} CI ${num(m.ci.low)}..${num(m.ci.high)}`
      );
    }
  }
  lines.push('', 'Against control (treatment minus control):');
  for (const c of r.comparisons) {
    const isRate = METRICS[c.metric].kind === 'rate';
    const f = isRate ? pct : num;
    const verdict = c.result.p < c.alpha ? 'significant' : 'not significant';
    lines.push(
      `  [${c.role}] ${c.variant} ${METRICS[c.metric].label}: ${f(c.result.diff)} CI ${f(
        c.result.ci.low
      )}..${f(c.result.ci.high)} p=${c.result.p.toExponential(2)} (α=${c.alpha.toFixed(
        4
      )}, ${verdict})`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// I/O. Not unit-tested: it needs both stores. Run it against a dev ClickHouse with seeded rows
// before trusting a change to the queries.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type ExposureRow = {
  userId: number;
  variant: string;
  firstSeen: number;
  nVariants: number;
  joined: number;
  inviteDismissed: number;
  feedSaved: number;
  hatCountOpened: number;
  hidAllHats: number;
};

async function main() {
  const exp = arg('exp') as ExperimentKey | undefined;
  if (!exp || !Object.hasOwn(experiments, exp)) {
    throw new Error(`--exp must be one of: ${Object.keys(experiments).join(', ')}`);
  }
  const event = arg('event') ?? 'birthday2026';
  const since = arg('since') ?? '2026-11-06';
  const until = arg('until') ?? new Date().toISOString().slice(0, 10);
  const params = { exp, event, since: `${since} 00:00:00`, until: `${until} 23:59:59` };

  const ch = createClient({
    url: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
  });
  const readonly = await (
    await ch.query({ query: `SELECT getSetting('readonly') AS r`, format: 'JSONEachRow' })
  ).json<{ r: number | string }>();
  if (Number(readonly[0]?.r ?? 0) < 1) throw new Error('ClickHouse account is not read-only');

  const exposedWhere = `type = 'Experiment_Exposure'
      AND JSONExtractString(details, 'exp') = {exp:String}
      AND userId > 0 AND time >= {since:DateTime} AND time <= {until:DateTime}`;

  const droppedRows = await (
    await ch.query({
      query: `SELECT assignment, uniqExact(userId) AS users FROM (
          SELECT userId, JSONExtractString(details, 'assignment') AS assignment
          FROM actions WHERE ${exposedWhere}) WHERE assignment != 'rule' GROUP BY assignment`,
      query_params: params,
      format: 'JSONEachRow',
    })
  ).json<{ assignment: string; users: number | string }>();

  // HatTurf actions are counted only at or after the user's first exposure.
  const ui = (action: string) =>
    `countIf(a.userId != 0 AND a.time >= e.firstSeen AND JSONExtractString(a.details, 'action') = '${action}')`;
  const rows = await (
    await ch.query({
      query: `WITH e AS (
          SELECT userId,
                 argMin(JSONExtractString(details, 'variant'), time) AS variant,
                 min(time) AS firstSeen,
                 uniqExact(JSONExtractString(details, 'variant')) AS nVariants
          FROM actions
          WHERE ${exposedWhere} AND JSONExtractString(details, 'assignment') = 'rule'
          GROUP BY userId)
        SELECT e.userId AS userId, e.variant AS variant, toUnixTimestamp(e.firstSeen) AS firstSeen,
               e.nVariants AS nVariants,
               ${ui('opt_in')} AS joined, ${ui('invite_dismiss')} AS inviteDismissed,
               ${ui('feed_place_save')} AS feedSaved, ${ui('hat_count_open')} AS hatCountOpened,
               ${ui('hide_all_hats_on')} AS hidAllHats
        FROM e LEFT JOIN (
          SELECT userId, time, details FROM actions
          WHERE type = 'HatTurf_Action' AND JSONExtractString(details, 'event') = {event:String}
            AND time >= {since:DateTime} AND time <= {until:DateTime}) AS a ON a.userId = e.userId
        GROUP BY e.userId, e.variant, e.firstSeen, e.nVariants`,
      query_params: params,
      format: 'JSONEachRow',
    })
  ).json<ExposureRow>();
  await ch.close();

  const pg = new PgClient({ connectionString: process.env.READOUT_DATABASE_URL });
  await pg.connect();
  await pg.query('SET default_transaction_read_only = on');
  const placements = new Map<number, { at: Date; source: string | null }[]>();
  const ids = rows.map((r) => Number(r.userId));
  for (let i = 0; i < ids.length; i += 10_000) {
    const res = await pg.query<{ userId: number; createdAt: Date; source: string | null }>(
      `SELECT "userId", "createdAt", data->>'source' AS source FROM "EventTurfSticker"
       WHERE event = $1 AND "userId" = ANY($2::int[])
         AND "createdAt" >= $3::timestamptz AND "createdAt" <= $4::timestamptz`,
      [event, ids.slice(i, i + 10_000), `${since}T00:00:00Z`, `${until}T23:59:59Z`]
    );
    for (const p of res.rows) {
      const list = placements.get(p.userId) ?? [];
      list.push({ at: p.createdAt, source: p.source });
      placements.set(p.userId, list);
    }
  }
  await pg.end();

  const users: ExposedUser[] = rows.map((r) => {
    const userId = Number(r.userId);
    const after = (placements.get(userId) ?? []).filter(
      (p) => p.at.getTime() >= Number(r.firstSeen) * 1000
    );
    const days = new Set(after.map((p) => p.at.toISOString().slice(0, 10)));
    return {
      userId,
      variant: r.variant,
      nVariants: Number(r.nVariants),
      outcomes: {
        joined: Number(r.joined),
        placedAny: after.length,
        placedFromFeed: after.filter((p) => p.source === 'feed').length,
        returned2Days: days.size >= 2 ? 1 : 0,
        placements: after.length,
        inviteDismissed: Number(r.inviteDismissed),
        feedSaved: Number(r.feedSaved),
        hatCountOpened: Number(r.hatCountOpened),
        hidAllHats: Number(r.hidAllHats),
      },
    };
  });

  const readout = buildReadout(exp, users);
  const dropped = Object.fromEntries(droppedRows.map((d) => [d.assignment, Number(d.users)]));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...readout, dropped }, null, 2));
  } else {
    console.log(formatReadout(readout, dropped));
  }
  if (readout.srm.mismatch) process.exitCode = 2;
}

if (process.argv[1]?.endsWith('readout.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
