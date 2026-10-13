import { NsfwLevel } from '~/server/common/enums';
import type {
  TextScanDeclared,
  TextScanLabel,
  TextScanOutcome,
  TextScanOutput,
} from '~/server/services/text-scan/types';
import { nsfwLevelFromName } from '~/server/services/text-scan/types';

export function highestNsfwLevel(value: number | null | undefined): number {
  if (!value || value <= 0) return 0;
  return 2 ** Math.floor(Math.log2(value));
}

export function evaluateTextScan(
  output: TextScanOutput,
  declared: TextScanDeclared,
  labels: TextScanLabel[]
): TextScanOutcome {
  const outcome: TextScanOutcome = { triggeredLabels: [], nsfwLevel: null };

  for (const label of labels) {
    switch (label) {
      case 'nsfw': {
        if (!output.nsfw) break;
        const detectedLevel = nsfwLevelFromName[output.nsfw.level];
        const declaredLevel = highestNsfwLevel(declared.nsfwLevel);
        const raised = detectedLevel > NsfwLevel.PG && detectedLevel > declaredLevel;
        outcome.nsfw = { detectedLevel, declaredLevel, raised, reason: output.nsfw.reason };
        outcome.nsfwLevel = detectedLevel;
        if (raised) outcome.triggeredLabels.push('nsfw');
        break;
      }
      case 'poi': {
        if (!output.poi) break;
        const isDeclared = !!declared.poi;
        outcome.poi = {
          detected: output.poi.detected,
          declared: isDeclared,
          newlyDetected: output.poi.detected && !isDeclared,
          names: output.poi.names,
          reason: output.poi.reason,
        };
        if (output.poi.detected) outcome.triggeredLabels.push('poi');
        break;
      }
      case 'minor': {
        if (!output.minor) break;
        const isDeclared = !!declared.minor;
        outcome.minor = {
          detected: output.minor.detected,
          declared: isDeclared,
          newlyDetected: output.minor.detected && !isDeclared,
          reason: output.minor.reason,
        };
        if (output.minor.detected) outcome.triggeredLabels.push('minor');
        break;
      }
      case 'scam': {
        if (!output.scam) break;
        outcome.scam = { detected: output.scam.detected, reason: output.scam.reason };
        if (output.scam.detected) outcome.triggeredLabels.push('scam');
        break;
      }
    }
  }
  return outcome;
}
