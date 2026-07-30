import { isEmpty } from 'lodash-es';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { slugit } from '~/utils/string-helpers';

export const minorFlagNotifications = createNotificationProcessor({
  'model-flagged-minor': {
    displayName: 'Model marked as minor',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) =>
      details && !isEmpty(details)
        ? {
            message: `Your model ${details.modelName} has been marked as depicting a minor. If you believe this is a mistake, contact support.`,
            url: `/models/${details.modelId}/${slugit(details.modelName)}`,
          }
        : undefined,
    // confirmMinorHashAutoFlag rewrites `source` to 'manual' and stashes the origin in
    // `confirmedFrom`, so polling `source` alone would skip every flag a moderator
    // affirmed before this ran — the case where the flag sticks for good.
    prepareQuery: ({ lastSent }) => `
      WITH flagged AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', m.id,
            'modelName', m.name
          ) "details"
        FROM "Model" m
        WHERE COALESCE(
                m.meta->'minorFlagSnapshot'->>'confirmedFrom',
                m.meta->'minorFlagSnapshot'->>'source'
              ) = 'auto'
          AND (m.meta->'minorFlagSnapshot'->>'at')::timestamptz > '${lastSent}'
          AND m."userId" <> -1
          -- The snapshot is written before the flag lands and survives an ordinary
          -- unflag, so its presence alone doesn't prove the model is currently minor.
          AND m.minor
      )
      SELECT
        concat('model-flagged-minor:', details->>'modelId', ':', '${lastSent}') "key",
        "userId",
        'model-flagged-minor' "type",
        details
      FROM flagged;
    `,
  },
});
