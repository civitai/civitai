import type { LinkedAccountReviewConfig } from './config';

/** One directed flow edge, with the sender's total outflow of that kind in the window. */
export type FlowEdge = { from: number; to: number; amount: number; senderTotal: number };
export type SignIn = { userId: number; ip: string; ipAccounts: number };

export type FlowInput = { stickers: FlowEdge[]; buzz: FlowEdge[] };

export type Flow = { toGroup: number; total: number; fromGroup: number };
export type Role = 'sends' | 'receives' | 'both' | 'linked-only';

export type GroupMember = {
  userId: number;
  role: Role;
  triggers: boolean;
  stickers: Flow;
  buzz: Flow;
  /** Other members this account shares qualifying sign-in IPs with, and how many. */
  links: { userId: number; sharedIps: number }[];
};

export type LinkedGroup = { members: GroupMember[] };

export type Thresholds = Pick<
  LinkedAccountReviewConfig,
  'ipAccountCap' | 'minSharedIps' | 'share' | 'stickerFloor' | 'buzzFloor'
>;

const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
const splitKey = (key: string) => key.split(',').map(Number) as [number, number];

export function candidateUsers({ stickers, buzz }: FlowInput): number[] {
  const users = new Set<number>();
  for (const e of [...stickers, ...buzz]) users.add(e.from).add(e.to);
  return [...users];
}

function sharedIpCounts(pairs: Set<string>, signIns: SignIn[], cap: number) {
  const ipsByUser = new Map<number, Set<string>>();
  for (const s of signIns) {
    if (s.ipAccounts > cap) continue;
    let ips = ipsByUser.get(s.userId);
    if (!ips) ipsByUser.set(s.userId, (ips = new Set()));
    ips.add(s.ip);
  }
  const shared = new Map<string, number>();
  for (const key of pairs) {
    const [a, b] = splitKey(key);
    const ipsA = ipsByUser.get(a);
    const ipsB = ipsByUser.get(b);
    if (!ipsA || !ipsB) continue;
    let n = 0;
    for (const ip of ipsA) if (ipsB.has(ip)) n++;
    if (n > 0) shared.set(key, n);
  }
  return shared;
}

export function findLinkedGroups(
  flows: FlowInput,
  signIns: SignIn[],
  t: Thresholds
): { candidatePairs: number; linkedPairs: number; groups: LinkedGroup[] } {
  const pairs = new Set<string>();
  for (const e of [...flows.stickers, ...flows.buzz]) {
    if (e.from !== e.to) pairs.add(pairKey(e.from, e.to));
  }

  const shared = sharedIpCounts(pairs, signIns, t.ipAccountCap);
  const linked = [...shared].filter(([, n]) => n >= t.minSharedIps);

  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = x; node !== root; ) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const [key] of linked) {
    const [a, b] = splitKey(key);
    parent.set(find(a), find(b));
  }
  const sameGroup = (a: number, b: number) => parent.has(a) && parent.has(b) && find(a) === find(b);

  const flowOf = new Map<number, { stickers: Flow; buzz: Flow }>();
  const flowFor = (u: number) => {
    let f = flowOf.get(u);
    if (!f) {
      f = {
        stickers: { toGroup: 0, total: 0, fromGroup: 0 },
        buzz: { toGroup: 0, total: 0, fromGroup: 0 },
      };
      flowOf.set(u, f);
    }
    return f;
  };
  for (const kind of ['stickers', 'buzz'] as const) {
    for (const e of flows[kind]) {
      const sender = flowFor(e.from)[kind];
      sender.total = e.senderTotal;
      if (!sameGroup(e.from, e.to)) continue;
      sender.toGroup += e.amount;
      flowFor(e.to)[kind].fromGroup += e.amount;
    }
  }

  const concentrated = (f: Flow, floor: number) =>
    f.total >= floor && f.toGroup / f.total >= t.share;

  const linksOf = new Map<number, { userId: number; sharedIps: number }[]>();
  for (const [key, n] of linked) {
    const [a, b] = splitKey(key);
    linksOf.set(a, [...(linksOf.get(a) ?? []), { userId: b, sharedIps: n }]);
    linksOf.set(b, [...(linksOf.get(b) ?? []), { userId: a, sharedIps: n }]);
  }

  const byRoot = new Map<number, GroupMember[]>();
  for (const userId of parent.keys()) {
    const f = flowFor(userId);
    const sends = f.stickers.toGroup > 0 || f.buzz.toGroup > 0;
    const receives = f.stickers.fromGroup > 0 || f.buzz.fromGroup > 0;
    const member: GroupMember = {
      userId,
      role: sends && receives ? 'both' : sends ? 'sends' : receives ? 'receives' : 'linked-only',
      triggers: concentrated(f.stickers, t.stickerFloor) || concentrated(f.buzz, t.buzzFloor),
      stickers: f.stickers,
      buzz: f.buzz,
      links: linksOf.get(userId) ?? [],
    };
    const root = find(userId);
    byRoot.set(root, [...(byRoot.get(root) ?? []), member]);
  }

  const groups = [...byRoot.values()]
    .filter((members) => members.some((m) => m.triggers))
    .map((members) => ({ members: members.sort((a, b) => a.userId - b.userId) }));

  return { candidatePairs: pairs.size, linkedPairs: linked.length, groups };
}

export type ControlState = 'grouped' | 'split' | 'missing' | 'unset';

export function controlState(groups: LinkedGroup[], controlUserIds: number[]): ControlState {
  if (controlUserIds.length === 0) return 'unset';
  const holding = groups.filter((g) => g.members.some((m) => controlUserIds.includes(m.userId)));
  if (holding.length === 0) return 'missing';
  const found = holding.flatMap((g) => g.members).filter((m) => controlUserIds.includes(m.userId));
  return holding.length === 1 && found.length === controlUserIds.length ? 'grouped' : 'split';
}

export const groupSignature = (g: LinkedGroup) => g.members.map((m) => m.userId).join(',');
