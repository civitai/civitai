import { describe, expect, it } from 'vitest';
import {
  controlState,
  findLinkedGroups,
  type FlowEdge,
  type SignIn,
  type Thresholds,
} from '../groups';

// Synthetic values throughout; none are the production configuration.
const T: Thresholds = {
  ipAccountCap: 4,
  minSharedIps: 3,
  share: 0.7,
  stickerFloor: 30,
  buzzFloor: 1_000,
};

const [A, B, C, D] = [101, 102, 103, 104];
const OUTSIDER = 201;
const NEAR_MISS = 202;

const signIn = (userId: number, ip: string, ipAccounts = 2): SignIn => ({ userId, ip, ipAccounts });
const shares = (a: number, b: number, ips: string[]) =>
  ips.flatMap((ip) => [signIn(a, ip), signIn(b, ip)]);
const buzz = (from: number, to: number, amount: number, senderTotal: number): FlowEdge => ({
  from,
  to,
  amount,
  senderTotal,
});

function controlShape() {
  const flows = {
    stickers: [] as FlowEdge[],
    buzz: [
      buzz(A, C, 1_000, 1_600),
      buzz(A, B, 500, 1_600),
      buzz(B, D, 1_200, 1_250),
      buzz(OUTSIDER, C, 2_000, 2_000),
      buzz(NEAR_MISS, D, 3_000, 3_000),
    ],
  };
  const signIns = [
    ...shares(A, C, ['ip1', 'ip2', 'ip3']),
    ...shares(B, D, ['ip4', 'ip5', 'ip6']),
    ...shares(A, B, ['ip1', 'ip4', 'ip7']),
    // Shared with the outsider only on IPs used by too many accounts.
    ...['busy1', 'busy2', 'busy3'].flatMap((ip) => [signIn(OUTSIDER, ip, 50), signIn(C, ip, 50)]),
    // Below the shared-IP minimum.
    ...shares(NEAR_MISS, D, ['ip8', 'ip9']),
  ];
  return { flows, signIns };
}

describe('findLinkedGroups', () => {
  it('returns the control shape as one group of four, without the decoys', () => {
    const { flows, signIns } = controlShape();
    const { groups } = findLinkedGroups(flows, signIns, T);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.userId)).toEqual([A, B, C, D]);
    expect(controlState(groups, [A, B, C, D])).toBe('grouped');
  });

  it('gives each member its role and marks the concentrated senders', () => {
    const { flows, signIns } = controlShape();
    const [group] = findLinkedGroups(flows, signIns, T).groups;
    const byId = new Map(group.members.map((m) => [m.userId, m]));

    expect(byId.get(A)).toMatchObject({ role: 'sends', triggers: true });
    expect(byId.get(B)).toMatchObject({ role: 'both', triggers: true });
    expect(byId.get(C)).toMatchObject({ role: 'receives', triggers: false });
    expect(byId.get(C)?.buzz.fromGroup).toBe(1_000);
  });

  it('links transitively: D has no direct link to A and still joins its group', () => {
    const { flows, signIns } = controlShape();
    const [group] = findLinkedGroups(flows, signIns, T).groups;
    const d = group.members.find((m) => m.userId === D);
    expect(d?.links.map((l) => l.userId)).toEqual([B]);
  });

  it('links only accounts that have flow between them', () => {
    const { flows, signIns } = controlShape();
    const noBridge = { ...flows, buzz: flows.buzz.filter((e) => !(e.from === A && e.to === B)) };
    const groups = findLinkedGroups(noBridge, signIns, T).groups;
    expect(groups.map((g) => g.members.map((m) => m.userId))).toEqual([[B, D]]);
  });

  it('drops a group whose flow is under the floor', () => {
    const { flows, signIns } = controlShape();
    const small = {
      stickers: [],
      buzz: [buzz(A, C, 300, 520), buzz(A, B, 200, 520), buzz(B, D, 400, 410)],
    };
    expect(findLinkedGroups({ ...flows, ...small }, signIns, T).groups).toEqual([]);
  });

  it('drops a group whose flow is not concentrated inside it', () => {
    const { signIns } = controlShape();
    const spread = {
      stickers: [],
      buzz: [buzz(A, C, 1_000, 6_000), buzz(A, B, 500, 6_000), buzz(B, D, 1_200, 6_000)],
    };
    expect(findLinkedGroups(spread, signIns, T).groups).toEqual([]);
  });

  it('counts sticker flow the same way', () => {
    const { signIns } = controlShape();
    const stickers = [{ from: A, to: C, amount: 40, senderTotal: 45 }];
    const [group] = findLinkedGroups({ stickers, buzz: [] }, signIns, T).groups;
    expect(group.members.find((m) => m.userId === A)).toMatchObject({ triggers: true });
  });
});

describe('controlState', () => {
  const { flows, signIns } = controlShape();
  const groups = findLinkedGroups(flows, signIns, T).groups;

  it('is unset with no control configured', () => {
    expect(controlState(groups, [])).toBe('unset');
  });

  it('is missing when no control account is in any group', () => {
    expect(controlState(groups, [9001, 9002])).toBe('missing');
  });

  it('is split when only part of the control is grouped', () => {
    expect(controlState(groups, [A, B, 9001])).toBe('split');
  });

  it('is split when the control lands in two groups', () => {
    const noBridge = { ...flows, buzz: flows.buzz.filter((e) => !(e.from === A && e.to === B)) };
    const both = findLinkedGroups(noBridge, signIns, { ...T, share: 0.6 }).groups;
    expect(both).toHaveLength(2);
    expect(controlState(both, [A, B, C, D])).toBe('split');
  });
});

describe('threshold boundaries', () => {
  const pair = (ipAccounts: number) => [
    ...['b1', 'b2', 'b3'].flatMap((ip) => [signIn(A, ip, ipAccounts), signIn(C, ip, ipAccounts)]),
  ];
  const flowsAt = (amount: number, senderTotal: number) => ({
    stickers: [],
    buzz: [buzz(A, C, amount, senderTotal)],
  });

  it('counts an IP used by exactly the cap', () => {
    expect(findLinkedGroups(flowsAt(1_000, 1_000), pair(T.ipAccountCap), T).groups).toHaveLength(1);
    expect(findLinkedGroups(flowsAt(1_000, 1_000), pair(T.ipAccountCap + 1), T).groups).toEqual([]);
  });

  it('triggers on stickers at exactly the floor', () => {
    const stickersAt = (amount: number) => ({
      stickers: [{ from: A, to: C, amount, senderTotal: amount }],
      buzz: [],
    });
    expect(findLinkedGroups(stickersAt(T.stickerFloor), pair(2), T).groups).toHaveLength(1);
    expect(findLinkedGroups(stickersAt(T.stickerFloor - 1), pair(2), T).groups).toEqual([]);
  });

  it('triggers at exactly the share and exactly the floor', () => {
    const total = T.buzzFloor;
    expect(findLinkedGroups(flowsAt(total * T.share, total), pair(2), T).groups).toHaveLength(1);
    expect(findLinkedGroups(flowsAt(total * T.share - 1, total), pair(2), T).groups).toEqual([]);
    expect(findLinkedGroups(flowsAt(total - 1, total - 1), pair(2), T).groups).toEqual([]);
  });
});
