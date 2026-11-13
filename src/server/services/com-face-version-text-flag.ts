import { ensureFliptInitialized, FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';

export type ComVersionTextHideMode = 'off' | 'on';

/**
 * Whether civitai.com hides version text without a passing verdict. Only an evaluated `false` is
 * off: an unknown flag or an unreachable Flipt reads as on, since off shows text never rated.
 */
export async function getComVersionTextHideMode(): Promise<ComVersionTextHideMode> {
  await ensureFliptInitialized().catch(() => undefined);
  const enabled = isFliptSync(FLIPT_FEATURE_FLAGS.COM_FACE_VERSION_TEXT_HIDE);
  if (enabled === null) {
    logToAxiom({
      type: 'error',
      name: 'com-face-version-text',
      message: 'hide flag not evaluated; hiding',
    }).catch(() => undefined);
    return 'on';
  }
  return enabled ? 'on' : 'off';
}
