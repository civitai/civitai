import { dbWrite } from '~/server/db/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import {
  getTextScanMode,
  getTextScanWebSearchMode,
  TEXT_SCAN_ENTITY_TYPES,
  TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { subjectTextLength } from '~/server/services/text-scan/prompt';
import { toSubmittedWorkflow } from '~/server/services/text-scan/route';
import { scanEntity } from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

export const TEXT_SCAN_RETRY_CONTENT = 'text-scan';

// Only the retry cron calls an adapter's submit, and it has already bumped the row it resubmits.
export async function submitViaTextScan(entityType: TextScanEntityType, entityId: number) {
  const result = await scanEntity({ entityType, entityId, fromRetry: true });
  // Only a callback spends a failed row's retry budget, so a scan that can never submit would be
  // reselected on every run, crowding out the rows behind it.
  if (result.status === 'skipped' && result.reason === 'missing-prompt')
    await dbWrite.entityModeration.updateMany({
      where: {
        entityType: { in: [entityType, textScanEmEntityType(entityType, 'shadow')] },
        entityId,
        status: { not: 'Succeeded' },
      },
      data: { retryCount: { increment: 1 } },
    });
  return toSubmittedWorkflow(result);
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

/** Retry-cron adapters for the web-search rows; enabled only while the search mode matches. */
export function textScanWebSearchAdapters() {
  return Object.fromEntries(
    TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES.flatMap((entityType) =>
      (['shadow', 'active'] as const).map((mode): [string, ModerationAdapter] => [
        textScanEmEntityType(entityType, mode, 'web-search'),
        {
          ...createTextScanAdapter(entityType, {}),
          submit: async ({ entityId }) =>
            toSubmittedWorkflow(
              await scanEntity({ entityType, entityId, fromRetry: true, pass: 'web-search' })
            ),
          isEnabled: async ({ entityId }) =>
            (await getTextScanWebSearchMode(entityType, entityId)) === mode,
        },
      ])
    )
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
      // Omitted ids take the retry cron's missing path (row deleted) instead of failing forever;
      // a not-public entity is kept so its row, and the verdict on it, survive.
      // `submit` rescans from the entity and ignores the content, so a marker avoids holding a
      // whole batch of composed text in memory.
      return new Map(
        [...subjects]
          .filter(([, subject]) => subject.notPublic || subjectTextLength(subject) >= minChars)
          .map(([id]) => [id, TEXT_SCAN_RETRY_CONTENT])
      );
    },
    submit: ({ entityId }) => submitViaTextScan(entityType, entityId),
    isEnabled: async ({ entityId }) => (await getTextScanMode(entityType, entityId)) === 'active',
    ...hooks,
  };
}
