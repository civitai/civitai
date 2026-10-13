import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import {
  getTextScanMode,
  TEXT_SCAN_ENTITY_TYPES,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { subjectTextLength } from '~/server/services/text-scan/prompt';
import { composeUserText } from '~/server/services/text-scan/segment';
import { scanEntity } from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

// Only the retry cron calls an adapter's submit, and it has already bumped the row it resubmits.
export async function submitViaTextScan(entityType: TextScanEntityType, entityId: number) {
  const result = await scanEntity({ entityType, entityId, fromRetry: true });
  return result.status === 'submitted' ? { id: result.workflowId } : null;
}

export function createTextScanShadowAdapter(entityType: TextScanEntityType): ModerationAdapter {
  return {
    ...createTextScanAdapter(entityType, {}),
    isEnabled: async ({ entityId }) => (await getTextScanMode(entityType, entityId)) === 'shadow',
  };
}

export function textScanShadowAdapters() {
  return Object.fromEntries(
    TEXT_SCAN_ENTITY_TYPES.map((entityType) => [
      textScanEmEntityType(entityType, 'shadow'),
      createTextScanShadowAdapter(entityType),
    ])
  );
}

export function createTextScanAdapter(
  entityType: TextScanEntityType,
  hooks: Pick<ModerationAdapter, 'applyTextScan' | 'applyFailure'>
): ModerationAdapter {
  return {
    resolveContent: async (ids) => {
      const profile = getTextScanProfile(entityType);
      if (!profile) return new Map();
      const subjects = await profile.load(ids);
      const minChars = profile.minChars ?? 1;
      // Omitted ids take the retry cron's missing path (row deleted) instead of failing forever.
      return new Map(
        [...subjects]
          .filter(([, subject]) => subjectTextLength(subject) >= minChars)
          .map(([id, subject]) => [id, composeUserText(subject)])
      );
    },
    submit: ({ entityId }) => submitViaTextScan(entityType, entityId),
    isEnabled: async ({ entityId }) => (await getTextScanMode(entityType, entityId)) === 'active',
    ...hooks,
  };
}
