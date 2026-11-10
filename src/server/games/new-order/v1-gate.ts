import { isFlipt } from '~/server/flipt/client';
import { KNIGHTS_APP_FLIPT_FLAG } from '~/shared/constants/knights.constants';

// Server-side switch for the old in-app Knights game: it is live until the Knights app's access flag is on
// for everyone. Launch means enabling it for all users with no partial rollout, because a percentage
// rollout could match this anonymous entity by hash. Flipt down or erroring leaves the old game live.
// Every gate on the old game reads this, so they can be removed with the rest of the old game.
let logged = false;
export async function isV1KnightsLive(): Promise<boolean> {
  try {
    return !(await isFlipt(KNIGHTS_APP_FLIPT_FLAG, 'anonymous'));
  } catch (error) {
    if (!logged) {
      logged = true;
      console.error(
        '[knights] could not read the Knights app flag, keeping the old game live',
        error
      );
    }
    return true;
  }
}
