import { placementRouter } from '~/server/routers/placement.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { STICKER_PLACEMENT_MIN_SCALE } from '~/shared/utils/sticker-placement';

/**
 * The caller context the placement router's tests share.
 *
 * Extracted after the account-state change had to hand-edit a second copy: the
 * create procedures moved to `guardedProcedure`, so every caller now needs
 * `muted` / `bannedAt` / `onboarding` present, and a file still building the old
 * shape refuses at the guard while reporting green about whatever it claims to
 * assert. The mocks themselves stay per-file — `vi.mock` is hoisted into the
 * module that declares it and cannot be shared from here.
 */

export const PLACER = 42;

// Sized off the schema's own bound rather than a literal, so a future change to
// the allowed range moves this with it instead of failing validation.
export const STICKER_DATA = {
  cosmeticId: 7,
  x: 0.1,
  y: 0.1,
  scale: STICKER_PLACEMENT_MIN_SCALE,
  rotation: 0,
};

type UserOverrides = {
  id?: number;
  isModerator?: boolean;
  muted?: boolean;
  bannedAt?: Date | null;
  onboarding?: number;
};

export const placementCaller = ({
  user = {},
  features = {},
}: {
  user?: UserOverrides;
  features?: Record<string, boolean>;
} = {}) =>
  placementRouter.createCaller({
    user: {
      id: PLACER,
      isModerator: false,
      muted: false,
      bannedAt: null,
      // The finished wizard. `guardedProcedure` is `verifiedProcedure` plus the
      // mute check, so an unset bit refuses every create call for a reason the
      // caller did not ask about.
      onboarding: OnboardingSteps.Buzz,
      ...user,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {
      isGreen: false,
      stickers: true,
      stickerPlacement: true,
      remixGallery: true,
      ...features,
    },
  } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
