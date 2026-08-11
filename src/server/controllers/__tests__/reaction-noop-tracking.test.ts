import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';

const { mockToggleReaction, mockUpdateEntityMetric, mockDbRead } = vi.hoisted(() => ({
  mockToggleReaction: vi.fn(),
  mockUpdateEntityMetric: vi.fn(async () => undefined),
  mockDbRead: {
    image: {
      findFirst: vi.fn(async () => ({ nsfwLevel: 1, userId: 99 })),
      findUniqueOrThrow: vi.fn(async () => ({ postId: 42 })),
    },
  },
}));

vi.mock('~/server/services/reaction.service', () => ({ toggleReaction: mockToggleReaction }));
vi.mock('~/server/utils/metric-helpers', () => ({ updateEntityMetric: mockUpdateEntityMetric }));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/services/collection.service', () => ({
  getContestsFromEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: vi.fn(async () => [{ hasAccess: true }]),
}));
vi.mock('~/server/rewards', () => ({
  encouragementReward: { apply: vi.fn(async () => undefined) },
  goodContentReward: { apply: vi.fn(async () => undefined) },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { notificationExists: vi.fn(async () => true) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));

import { toggleReactionHandler } from '~/server/controllers/reaction.controller';

const input = { entityType: 'image', entityId: 1, reaction: 'Like' } as const;

function makeCtx() {
  return {
    user: { id: 5, isModerator: false },
    ip: '127.0.0.1',
    track: { reaction: vi.fn(async () => undefined) },
  } as unknown as ProtectedContext & { track: { reaction: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleReactionHandler — a delete that removed nothing', () => {
  it('emits no tracker event and no metric decrement on noop', async () => {
    mockToggleReaction.mockResolvedValue('noop');
    const ctx = makeCtx();

    const result = await toggleReactionHandler({ ctx, input });

    expect(result).toBe('noop');
    expect(ctx.track.reaction).not.toHaveBeenCalled();
    expect(mockUpdateEntityMetric).not.toHaveBeenCalled();
  });

  // Negative control: the guards must be keyed on 'noop', not simply switched off.
  it('still emits both when a row really was removed', async () => {
    mockToggleReaction.mockResolvedValue('removed');
    const ctx = makeCtx();

    await toggleReactionHandler({ ctx, input });

    expect(ctx.track.reaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Image_Delete', entityId: 1 })
    );
    expect(mockUpdateEntityMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metricType: 'ReactionLike', amount: -1 })
    );
  });
});
