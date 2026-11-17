import { hasFailedScan } from '~/server/utils/failed-scan';
import { isModelWithheld } from '~/shared/utils/model-withhold';
import {
  Availability,
  ModelFileVisibility,
  ModelModifier,
  ModelStatus,
  ModelUsageControl,
  type ScanResultCode,
} from '~/shared/utils/prisma/enums';

export type HashServableCopy = {
  fileVisibility: string;
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
  versionStatus: string;
  versionAvailability: string;
  usageControl: string;
  modelStatus: string;
  modelMode: string | null;
  modelAvailability: string;
  poi: boolean;
};

/**
 * Would the content-hash download URL offer this copy to every caller, not only its owner or a
 * moderator? The same terms as `findHashCandidates`' non-owner branch (download-by-hash.service),
 * which a change to either must keep in step.
 */
export function hashRouteServesEveryone(copy: HashServableCopy): boolean {
  return (
    copy.fileVisibility === ModelFileVisibility.Public &&
    !hasFailedScan(copy) &&
    copy.versionStatus === ModelStatus.Published &&
    copy.versionAvailability !== Availability.Private &&
    copy.usageControl === ModelUsageControl.Download &&
    copy.modelStatus === ModelStatus.Published &&
    copy.modelMode !== ModelModifier.Archived &&
    !isModelWithheld({ mode: copy.modelMode }) &&
    copy.modelAvailability !== Availability.Private &&
    !copy.poi
  );
}
