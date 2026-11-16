import { createHash } from 'node:crypto';
import * as z from 'zod';

export const linkDetectionConfigSchema = z.object({
  lookbackDays: z.number().int().positive(),
  maxEarners: z.number().int().positive(),
  maxTipRows: z.number().int().positive(),
  ipMaxAccounts: z.number().int().positive(),
  ipMinShared: z.number().int().positive(),
  sinkMinShare: z.number().min(0).max(1),
  sinkMinTips: z.number().int().positive(),
  burstSeconds: z.number().positive(),
  burstMinTips: z.number().int().positive(),
  createdGapSeconds: z.number().positive(),
  createdMinAccounts: z.number().int().positive(),
  weights: z.object({
    ip: z.number(),
    sink: z.number(),
    burst: z.number(),
    created: z.number(),
  }),
  blockScore: z.number(),
  reviewScore: z.number(),
});

export type LinkDetectionConfig = z.infer<typeof linkDetectionConfigSchema>;

export function parseLinkDetectionConfig(raw: unknown): LinkDetectionConfig | null {
  const parsed = linkDetectionConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type IpGroup = { members: number[]; totalAccounts: number };
export type TipRow = { from: number; to: number; amount: number; at: number };
export type AccountCreation = { userId: number; createdAt: Date };

export type SinkEvidence = {
  sinkId: number;
  feederIds: number[];
  tipCount: number;
  amount: number;
  burst: boolean;
};

export type LinkEvidence = {
  sinks: SinkEvidence[];
  ipLinks: Array<{ userIds: number[]; sharedIps: number }>;
  createdTogether: number[][];
};

export type LinkDecision = 'block' | 'review';

export type LinkCluster = {
  userIds: number[];
  evidence: LinkEvidence;
  buzzMoved: number;
  score: number;
  decision: LinkDecision;
};

class DisjointSet {
  private parent = new Map<number, number>();
  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number) {
    this.parent.set(this.find(a), this.find(b));
  }
  groups(ids: Iterable<number>) {
    const out = new Map<number, number[]>();
    for (const id of ids) {
      const root = this.find(id);
      out.set(root, [...(out.get(root) ?? []), id]);
    }
    return [...out.values()];
  }
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function hasBurst(times: number[], windowSeconds: number, minTips: number) {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 0; i + minTips - 1 < sorted.length; i++) {
    if (sorted[i + minTips - 1] - sorted[i] <= windowSeconds) return true;
  }
  return false;
}

function createdRuns(accounts: AccountCreation[], gapSeconds: number, minAccounts: number) {
  const sorted = [...accounts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const runs: number[][] = [];
  let run: AccountCreation[] = [];
  for (const account of sorted) {
    const prev = run[run.length - 1];
    if (prev && account.createdAt.getTime() - prev.createdAt.getTime() > gapSeconds * 1000) {
      if (run.length >= minAccounts) runs.push(run.map((a) => a.userId));
      run = [];
    }
    run.push(account);
  }
  if (run.length >= minAccounts) runs.push(run.map((a) => a.userId));
  return runs;
}

export function detectLinkedClusters({
  earners,
  ipGroups,
  tips,
  accounts,
  config,
}: {
  earners: number[];
  ipGroups: IpGroup[];
  tips: TipRow[];
  accounts: AccountCreation[];
  config: LinkDetectionConfig;
}): LinkCluster[] {
  const earnerSet = new Set(earners);
  const sets = new DisjointSet();

  const sharedByPair = new Map<string, number>();
  for (const group of ipGroups) {
    if (group.totalAccounts > config.ipMaxAccounts) continue;
    const members = [...new Set(group.members)].filter((id) => earnerSet.has(id));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i], members[j]);
        sharedByPair.set(key, (sharedByPair.get(key) ?? 0) + 1);
      }
    }
  }
  const ipLinks: LinkEvidence['ipLinks'] = [];
  for (const [key, sharedIps] of sharedByPair) {
    if (sharedIps < config.ipMinShared) continue;
    const [a, b] = key.split(':').map(Number);
    sets.union(a, b);
    ipLinks.push({ userIds: [a, b], sharedIps });
  }

  const outflow = new Map<number, Map<number, TipRow[]>>();
  for (const tip of tips) {
    if (!earnerSet.has(tip.from) || tip.from === tip.to) continue;
    const byRecipient = outflow.get(tip.from) ?? new Map<number, TipRow[]>();
    byRecipient.set(tip.to, [...(byRecipient.get(tip.to) ?? []), tip]);
    outflow.set(tip.from, byRecipient);
  }

  const feedersBySink = new Map<number, number[]>();
  for (const [from, byRecipient] of outflow) {
    const total = [...byRecipient.values()].flat().reduce((sum, t) => sum + t.amount, 0);
    if (total <= 0) continue;
    for (const [to, rows] of byRecipient) {
      const amount = rows.reduce((sum, t) => sum + t.amount, 0);
      if (rows.length >= config.sinkMinTips && amount / total >= config.sinkMinShare) {
        feedersBySink.set(to, [...(feedersBySink.get(to) ?? []), from]);
      }
    }
  }

  const sinks: SinkEvidence[] = [];
  const createdTogether: number[][] = [];
  const seenRuns = new Set<string>();
  const createdAt = new Map(accounts.map((a) => [a.userId, a]));
  for (const [sinkId, feederIds] of feedersBySink) {
    const rows = feederIds.flatMap((f) => outflow.get(f)?.get(sinkId) ?? []);
    for (const feeder of feederIds) sets.union(feeder, sinkId);
    sinks.push({
      sinkId,
      feederIds: [...feederIds].sort((a, b) => a - b),
      tipCount: rows.length,
      amount: rows.reduce((sum, t) => sum + t.amount, 0),
      burst: hasBurst(
        rows.map((r) => r.at),
        config.burstSeconds,
        config.burstMinTips
      ),
    });
    const group = feederIds.flatMap((id) => (createdAt.has(id) ? [createdAt.get(id)!] : []));
    for (const run of createdRuns(group, config.createdGapSeconds, config.createdMinAccounts)) {
      const key = [...run].sort((a, b) => a - b).join(',');
      if (!seenRuns.has(key)) {
        seenRuns.add(key);
        createdTogether.push(run);
      }
    }
  }

  const nodes = new Set<number>([
    ...ipLinks.flatMap((l) => l.userIds),
    ...sinks.flatMap((s) => [s.sinkId, ...s.feederIds]),
  ]);

  const clusters: LinkCluster[] = [];
  for (const members of sets.groups(nodes)) {
    if (members.length < 2) continue;
    const inCluster = new Set(members);
    const evidence: LinkEvidence = {
      sinks: sinks.filter((s) => inCluster.has(s.sinkId)),
      ipLinks: ipLinks.filter((l) => l.userIds.every((id) => inCluster.has(id))),
      createdTogether: createdTogether.filter((run) => run.every((id) => inCluster.has(id))),
    };
    const score =
      (evidence.ipLinks.length ? config.weights.ip : 0) +
      (evidence.sinks.length ? config.weights.sink : 0) +
      (evidence.sinks.some((s) => s.burst) ? config.weights.burst : 0) +
      (evidence.createdTogether.length ? config.weights.created : 0);
    if (score < config.reviewScore) continue;
    clusters.push({
      userIds: [...members].sort((a, b) => a - b),
      evidence,
      buzzMoved: evidence.sinks.reduce((sum, s) => sum + s.amount, 0),
      score,
      decision: score >= config.blockScore ? 'block' : 'review',
    });
  }
  return clusters.sort((a, b) => b.score - a.score || a.userIds[0] - b.userIds[0]);
}

export const clusterFingerprint = (userIds: number[]) =>
  createHash('sha256')
    .update([...userIds].sort((a, b) => a - b).join(','))
    .digest('hex')
    .slice(0, 32);
