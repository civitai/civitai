import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

export async function getExperimentalFlags(user: SessionUser) {
  const experimental = await isFlipt(
    FLIPT_FEATURE_FLAGS.GENERATION_EXPERIMENTAL,
    String(user.id),
    buildFliptContext(user)
  );

  return { experimental };
}
