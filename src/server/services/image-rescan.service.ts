import { BlockedReason } from '~/server/common/enums';
import { graceBlockedSql, scanKeepsByMarkerSql } from '~/server/common/image-visibility';
import { dbWrite } from '~/server/db/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { blockKeptByBanSql } from '~/server/services/image-scan-pipeline';
import { ingestImageById } from '~/server/services/image.service';

/**
 * A moderator's rescan of one image. A row the scan may decide again is moved to Rescan first, its
 * reason and level kept until the verdict; any other row is sent as it stands.
 */
export async function rescanImageById({ id }: GetByIdInput) {
  await dbWrite.$executeRaw`
    UPDATE "Image" SET ingestion = 'Rescan'::"ImageIngestionStatus",
      "scanJobs" = CASE WHEN jsonb_typeof("scanJobs") = 'object'
        THEN jsonb_set("scanJobs", '{retryCount}', '0'::jsonb) ELSE "scanJobs" END
    WHERE id = ${id}
      AND ingestion IN ('Blocked'::"ImageIngestionStatus", 'Error'::"ImageIngestionStatus")
      AND "blockedFor" IS NOT NULL
      AND "blockedFor" NOT IN (${BlockedReason.AiNotVerified}, ${BlockedReason.CSAM})
      AND NOT ${scanKeepsByMarkerSql('Image')}
      AND NOT ${blockKeptByBanSql('Image')}
      AND NOT ${graceBlockedSql}
  `;
  return ingestImageById({ id });
}
