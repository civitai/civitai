import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

// The old in-app Knights game is live until the Knights app's access flag is on for everyone. Launch
// means enabling it for all users with no partial rollout, because a percentage rollout could match
// this anonymous entity by hash. Flipt down or erroring leaves the old game live.
let logged = false;
export async function isV1KnightsLive(): Promise<boolean> {
  try {
    return !(await isFlipt(FLIPT_FEATURE_FLAGS.KNIGHTS_APP, 'anonymous'));
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
