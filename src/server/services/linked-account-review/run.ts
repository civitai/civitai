import type { AbuseReportInput } from '@civitai/moderation';
import { MAX_FINDINGS_PER_REPORT, MAX_REASON_LENGTH } from '@civitai/moderation';
import { parseConfig } from './config';
import {
  candidateUsers,
  controlState,
  findLinkedGroups,
  groupSignature,
  type Flow,
  type GroupMember,
  type LinkedGroup,
} from './groups';
import type { LinkedAccountReader, Standing } from './read';

export const LINKED_ACCOUNT_REVIEW_DETECTOR = 'linked-account-review';

const DAY_MS = 24 * 60 * 60 * 1000;

export type FiledStore = {
  get: (signatures: string[]) => Promise<Map<string, string>>;
  set: (entries: [signature: string, filedAt: string][]) => Promise<void>;
};

export type LinkedAccountReviewDeps = {
  readConfig: () => Promise<string | null | undefined>;
  reader: LinkedAccountReader | null;
  filed: FiledStore;
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log: (level: 'info' | 'error', name: string, data: Record<string, unknown>) => void;
};

export type LinkedAccountReviewResult =
  | { status: 'not-configured'; error: string }
  | { status: 'no-reader' }
  | {
      status: 'dry-run' | 'filed';
      control: ReturnType<typeof controlState>;
      counters: Record<string, number>;
      findings: number;
    };

const pct = (f: Flow) => (f.total > 0 ? Math.round((f.toGroup / f.total) * 100) : 0);
const fmt = (n: number) => n.toLocaleString('en-US');

const LISTED = 25;
const listed = (items: string[]) =>
  items.length > LISTED
    ? `${items.slice(0, LISTED).join(', ')} +${items.length - LISTED} more`
    : items.join(', ');

function confidence(member: GroupMember, groupHasStanding: boolean) {
  const band = member.triggers ? (groupHasStanding ? 0.9 : 0.6) : 0.45;
  const strongest = Math.max(
    member.stickers.total ? member.stickers.toGroup / member.stickers.total : 0,
    member.buzz.total ? member.buzz.toGroup / member.buzz.total : 0
  );
  return Math.min(0.99, band + 0.09 * strongest);
}

function reason(
  member: GroupMember,
  group: LinkedGroup,
  standings: Standing[],
  excluded: Set<number>,
  flowDays: number
) {
  const links = listed(member.links.map((l) => `#${l.userId} (${l.sharedIps})`));
  const others = listed(
    group.members.filter((m) => m.userId !== member.userId).map((m) => `#${m.userId}`)
  );
  const own = standings.filter((s) => s.userId === member.userId);
  const standing = own.length
    ? own.map((s) => `#${s.position} on ${s.leaderboardId}`).join(', ')
    : 'none';
  const parts = [
    `Role: ${member.role}${member.triggers ? ', meets the review rule' : ''}.`,
    `${flowDays}-day stickers to group: ${fmt(member.stickers.toGroup)} of ${fmt(
      member.stickers.total
    )} (${pct(member.stickers)}%), from group: ${fmt(member.stickers.fromGroup)}.`,
    `${flowDays}-day Buzz to group: ${fmt(member.buzz.toGroup)} of ${fmt(member.buzz.total)} (${pct(
      member.buzz
    )}%), from group: ${fmt(member.buzz.fromGroup)}.`,
    `Current leaderboard standing: ${standing}.`,
    `Already excluded from leaderboards: ${excluded.has(member.userId) ? 'yes' : 'no'}.`,
    `Group of ${group.members.length}: ${others}.`,
    `Shared sign-in IPs with: ${links}.`,
  ];
  const text = parts.join(' ');
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

export async function runLinkedAccountReview(
  deps: LinkedAccountReviewDeps
): Promise<LinkedAccountReviewResult> {
  const parsed = parseConfig(await deps.readConfig());
  if (!parsed.ok) {
    deps.log('error', 'linked-account-review-not-configured', { error: parsed.error });
    return { status: 'not-configured', error: parsed.error };
  }
  const config = parsed.config;
  if (!deps.reader) {
    deps.log('error', 'linked-account-review-no-reader', {});
    return { status: 'no-reader' };
  }

  const startedAt = deps.now();
  const flows = await deps.reader.flows(
    config,
    new Date(startedAt.getTime() - config.flowDays * DAY_MS)
  );
  const users = candidateUsers(flows);
  const signIns = await deps.reader.signIns(
    users,
    new Date(startedAt.getTime() - config.linkDays * DAY_MS)
  );
  const { candidatePairs, linkedPairs, groups } = findLinkedGroups(flows, signIns, config);

  const control = controlState(groups, config.controlUserIds);
  if (control !== 'grouped') deps.log('error', 'linked-account-review-control', { control });

  const members = groups.flatMap((g) => g.members.map((m) => m.userId));
  const [standings, excludedIds] = await Promise.all([
    deps.reader.standings(members),
    deps.reader.excluded(members),
  ]);
  const excluded = new Set(excludedIds);
  const withStanding = new Set(standings.map((s) => s.userId));

  const notAllExcluded = groups.filter((g) =>
    g.members.some((m) => m.triggers && !excluded.has(m.userId))
  );
  const lastFiled = await deps.filed.get(notAllExcluded.map(groupSignature));
  const refileBefore = startedAt.getTime() - config.refileDays * DAY_MS;
  const due = notAllExcluded.filter((g) => {
    const at = lastFiled.get(groupSignature(g));
    return !at || Date.parse(at) < refileBefore;
  });

  const toFile: LinkedGroup[] = [];
  let findingCount = 0;
  let tooLarge = 0;
  for (const g of due) {
    if (g.members.length > MAX_FINDINGS_PER_REPORT) tooLarge++;
    if (findingCount + g.members.length > MAX_FINDINGS_PER_REPORT) continue;
    toFile.push(g);
    findingCount += g.members.length;
  }
  if (tooLarge) deps.log('error', 'linked-account-review-group-too-large', { groups: tooLarge });

  const findings = toFile.flatMap((g, i) => {
    const hasStanding = g.members.some((m) => withStanding.has(m.userId));
    return g.members.map((m) => ({
      userId: m.userId,
      confidence: confidence(m, hasStanding),
      reason: reason(m, g, standings, excluded, config.flowDays),
      actioned: false as const,
      action: null,
      groupKey: String(i + 1),
    }));
  });

  const dryRun = config.mode === 'dry-run';
  const counters: Record<string, number> = {
    dry_run: dryRun ? 1 : 0,
    candidate_pairs: candidatePairs,
    linked_pairs: linkedPairs,
    groups: groups.length,
    group_accounts: members.length,
    triggering_accounts: groups.flatMap((g) => g.members).filter((m) => m.triggers).length,
    groups_with_leaderboard_standing: groups.filter((g) =>
      g.members.some((m) => withStanding.has(m.userId))
    ).length,
    skipped_all_excluded: groups.length - notAllExcluded.length,
    skipped_recently_filed: notAllExcluded.length - due.length,
    skipped_over_cap: due.length - toFile.length,
    groups_too_large: tooLarge,
    groups_due: toFile.length,
    findings_due: findings.length,
    control_grouped: control === 'grouped' ? 1 : 0,
    control_split: control === 'split' ? 1 : 0,
    control_missing: control === 'missing' ? 1 : 0,
    control_unset: control === 'unset' ? 1 : 0,
  };

  const summary = dryRun
    ? `Dry run: ${toFile.length} groups (${findings.length} accounts) would be filed. Control: ${control}.`
    : `${toFile.length} linked-account groups (${findings.length} accounts) for review. Control: ${control}.`;

  await deps.sendReport({
    detector: LINKED_ACCOUNT_REVIEW_DETECTOR,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    summary,
    counters,
    findings: dryRun ? [] : findings,
    requireGroupKey: true,
  });

  if (!dryRun) {
    const filedAt = startedAt.toISOString();
    await deps.filed.set(toFile.map((g) => [groupSignature(g), filedAt]));
  }

  deps.log('info', 'linked-account-review-run', { control, ...counters });
  return { status: dryRun ? 'dry-run' : 'filed', control, counters, findings: findings.length };
}
