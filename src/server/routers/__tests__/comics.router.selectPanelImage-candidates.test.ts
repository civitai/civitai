import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { comicsRouter } from '../comics.router';

const OWNER = 5;

function selectFrom(candidateImages: unknown[], selectedImageKey: string, isGreen = false) {
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue({
    id: 1,
    workflowId: null,
    metadata: { candidateImages },
    chapter: { project: { userId: OWNER } },
  } as never);
  const caller = comicsRouter.createCaller({
    user: { id: OWNER, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
  } as never);
  return caller.selectPanelImage({ panelId: 1, selectedImageKey });
}

const NOT_AVAILABLE = /not among the available/;

describe('selectPanelImage candidate choice', () => {
  it('refuses the key a locked candidate keeps', async () => {
    const locked = { requiresUnlock: true, blockedReason: 'canUpgrade', key: 'kept', nsfwLevel: 1 };
    await expect(selectFrom([locked], 'kept')).rejects.toThrow(NOT_AVAILABLE);
  });

  it('refuses a key on the green site unless its level is rated safe', async () => {
    await expect(
      selectFrom([{ key: 'mature', nsfwLevel: NsfwLevel.R }], 'mature', true)
    ).rejects.toThrow(NOT_AVAILABLE);
    await expect(selectFrom(['plain'], 'plain', true)).rejects.toThrow(NOT_AVAILABLE);
  });

  it('refuses a key no candidate holds', async () => {
    await expect(selectFrom([{ key: 'a', nsfwLevel: 1 }], 'b')).rejects.toThrow(NOT_AVAILABLE);
  });

  it('accepts an unlocked candidate key off the green site', async () => {
    await expect(
      selectFrom([{ key: 'mature', nsfwLevel: NsfwLevel.R }], 'mature')
    ).rejects.not.toThrow(NOT_AVAILABLE);
  });
});
