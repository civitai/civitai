import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import {
  assertCanPromote,
  assertGroupAdmin,
  assertRoomForMembers,
  normalizeChatName,
  resolveChatIdentity,
  selectNextOwner,
} from '~/server/utils/chat-group';
import type { GroupMemberLike } from '~/server/utils/chat-group';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';

/**
 * Group chats (868kv2rht). Membership used to be frozen at creation, so the
 * rules that matter here are the ones that let it move without letting anyone
 * move it: exactly one admin, and only that admin adding, removing or handing
 * over.
 */

const at = (iso: string) => new Date(iso);

const member = (overrides: Partial<GroupMemberLike> & { id: number }): GroupMemberLike => ({
  userId: overrides.id * 100,
  isOwner: false,
  status: ChatMemberStatus.Joined,
  createdAt: at('2026-01-01T00:00:00Z'),
  joinedAt: null,
  ...overrides,
});

const group = { isGroup: true, ownerId: 1 };

describe('resolveChatIdentity', () => {
  it('keeps the member-set hash for a 1:1 so re-opening a DM finds the thread', () => {
    expect(resolveChatIdentity({ userIds: [7, 3] })).toEqual({ isGroup: false, hash: '3-7' });
  });

  it('gives a group no hash, so two groups with the same people can coexist', () => {
    const first = resolveChatIdentity({ userIds: [3, 7, 9] });
    const second = resolveChatIdentity({ userIds: [9, 7, 3] });
    expect(first).toEqual({ isGroup: true, hash: null });
    expect(second).toEqual({ isGroup: true, hash: null });
  });

  it('honours an explicit group of two, which is the only way to have a second thread with one person', () => {
    expect(resolveChatIdentity({ userIds: [3, 7], isGroup: true })).toEqual({
      isGroup: true,
      hash: null,
    });
  });

  it('honours an explicit 1:1 even with a repeated id', () => {
    expect(resolveChatIdentity({ userIds: [3, 7, 7] })).toEqual({ isGroup: false, hash: '3-7' });
  });
});

describe('normalizeChatName', () => {
  it('keeps a real name, trimmed', () => {
    expect(normalizeChatName('  Weekend crew  ')).toBe('Weekend crew');
  });

  it('preserves inner spacing', () => {
    expect(normalizeChatName('the  gang')).toBe('the  gang');
  });

  it('collapses every flavour of "no name" to null, so a cleared name falls back to the member list', () => {
    for (const blank of ['', '   ', '\t\n', null, undefined]) {
      expect(normalizeChatName(blank)).toBeNull();
    }
  });
});

describe('assertGroupAdmin', () => {
  it('allows the owner', () => {
    expect(() => assertGroupAdmin({ chat: group, actorId: 1 })).not.toThrow();
  });

  it('rejects a member who is not the owner', () => {
    expect(() => assertGroupAdmin({ chat: group, actorId: 2 })).toThrow(TRPCError);
  });

  it('allows a moderator to unstick a group they do not own', () => {
    expect(() => assertGroupAdmin({ chat: group, actorId: 2, isModerator: true })).not.toThrow();
  });

  it('rejects a 1:1 conversation, which has no membership to administer', () => {
    expect(() => assertGroupAdmin({ chat: { isGroup: false, ownerId: 1 }, actorId: 1 })).toThrow(
      TRPCError
    );
    // A moderator does not turn a DM into a group either.
    expect(() =>
      assertGroupAdmin({ chat: { isGroup: false, ownerId: 1 }, actorId: 9, isModerator: true })
    ).toThrow(TRPCError);
  });
});

describe('assertRoomForMembers', () => {
  const seats = (count: number, status = ChatMemberStatus.Joined) =>
    Array.from({ length: count }, () => ({ status }));

  it('allows filling the last seat exactly', () => {
    expect(() => assertRoomForMembers({ members: seats(9), adding: 1, limit: 10 })).not.toThrow();
  });

  it('rejects one past the limit', () => {
    expect(() => assertRoomForMembers({ members: seats(10), adding: 1, limit: 10 })).toThrow(
      TRPCError
    );
    expect(() => assertRoomForMembers({ members: seats(9), adding: 2, limit: 10 })).toThrow(
      TRPCError
    );
  });

  it('does not count members who left or were removed', () => {
    const members = [
      ...seats(8),
      ...seats(4, ChatMemberStatus.Left),
      ...seats(4, ChatMemberStatus.Kicked),
    ];
    expect(() => assertRoomForMembers({ members, adding: 2, limit: 10 })).not.toThrow();
    expect(() => assertRoomForMembers({ members, adding: 3, limit: 10 })).toThrow(TRPCError);
  });
});

// Renaming shares `assertGroupAdmin` with adding and removing, so the gate is
// covered above. These pin that a rename cannot be the one action that escapes it.
describe('rename authorization', () => {
  it('rejects a non-owner', () => {
    expect(() => assertGroupAdmin({ chat: group, actorId: 2 })).toThrow(TRPCError);
  });

  it('rejects renaming a 1:1, which has no name to show', () => {
    expect(() => assertGroupAdmin({ chat: { isGroup: false, ownerId: 1 }, actorId: 1 })).toThrow(
      TRPCError
    );
  });
});

describe('assertCanPromote', () => {
  const target = member({ id: 2, status: ChatMemberStatus.Joined });

  it('allows the owner to hand the group to a joined member', () => {
    expect(() => assertCanPromote({ chat: group, target, actorId: 1 })).not.toThrow();
  });

  it('rejects a non-owner', () => {
    expect(() => assertCanPromote({ chat: group, target, actorId: 2 })).toThrow(TRPCError);
    expect(() => assertCanPromote({ chat: group, target, actorId: 3 })).toThrow(TRPCError);
  });

  it('rejects promoting the current admin', () => {
    expect(() =>
      assertCanPromote({ chat: group, target: { ...target, isOwner: true }, actorId: 1 })
    ).toThrow(TRPCError);
  });

  it('rejects a member who has not joined, so the group cannot be parked on someone absent', () => {
    for (const status of [
      ChatMemberStatus.Invited,
      ChatMemberStatus.Ignored,
      ChatMemberStatus.Left,
      ChatMemberStatus.Kicked,
    ]) {
      expect(() =>
        assertCanPromote({ chat: group, target: { ...target, status }, actorId: 1 })
      ).toThrow(TRPCError);
    }
  });
});

describe('selectNextOwner', () => {
  it('picks the longest-joined remaining member', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({ id: 2, joinedAt: at('2026-03-01T00:00:00Z') }),
      member({ id: 3, joinedAt: at('2026-02-01T00:00:00Z') }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(3);
  });

  it('never returns the member who is leaving', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({ id: 2, joinedAt: at('2026-02-01T00:00:00Z') }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(2);
    expect(selectNextOwner(members, 2)?.id).toBe(1);
  });

  it('skips members who already left or were removed', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({ id: 2, status: ChatMemberStatus.Left, joinedAt: at('2026-01-02T00:00:00Z') }),
      member({ id: 3, status: ChatMemberStatus.Kicked, joinedAt: at('2026-01-03T00:00:00Z') }),
      member({ id: 4, joinedAt: at('2026-06-01T00:00:00Z') }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(4);
  });

  it('prefers a joined member over an invited one regardless of seniority', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({
        id: 2,
        status: ChatMemberStatus.Invited,
        createdAt: at('2026-01-02T00:00:00Z'),
      }),
      member({ id: 3, joinedAt: at('2026-09-01T00:00:00Z') }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(3);
  });

  it('falls back to an invited member rather than leaving the group ownerless', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({ id: 2, status: ChatMemberStatus.Invited, createdAt: at('2026-02-01T00:00:00Z') }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(2);
  });

  it('falls back to createdAt when a member has no joinedAt', () => {
    const members = [
      member({ id: 1, isOwner: true, joinedAt: at('2026-01-01T00:00:00Z') }),
      member({ id: 2, createdAt: at('2026-05-01T00:00:00Z'), joinedAt: null }),
      member({ id: 3, createdAt: at('2026-04-01T00:00:00Z'), joinedAt: null }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(3);
  });

  it('breaks ties on member id so the choice is stable', () => {
    const sameMoment = at('2026-01-01T00:00:00Z');
    const members = [
      member({ id: 1, isOwner: true, joinedAt: sameMoment }),
      member({ id: 5, joinedAt: sameMoment }),
      member({ id: 3, joinedAt: sameMoment }),
    ];
    expect(selectNextOwner(members, 1)?.id).toBe(3);
    expect(selectNextOwner([...members].reverse(), 1)?.id).toBe(3);
  });

  it('returns undefined when the leaver is the last one standing', () => {
    const members = [
      member({ id: 1, isOwner: true }),
      member({ id: 2, status: ChatMemberStatus.Left }),
    ];
    expect(selectNextOwner(members, 1)).toBeUndefined();
  });
});
