import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

type TrainingMediaType = TrainingDetailsObj['mediaType'];

// The Training Studio toggle is Flipt-gated: its key is withheld from users who aren't granted,
// so absence means there is nothing for them to switch to (same test as SettingsCard).
export function isStudioToggleAvailable(userFeatures: Record<string, boolean> | undefined) {
  return !!userFeatures && 'trainingStudioUi' in userFeatures;
}

// Takes the flags object so the call site can't pick the wrong flag: this is the OLD trainer's
// `audioTraining`, not the Studio's `training-studio-audio-training`.
export function showStudioAudioNotice({
  features,
  studioToggleAvailable,
  mediaType,
}: {
  features: Pick<FeatureAccess, 'audioTraining'>;
  studioToggleAvailable: boolean;
  mediaType: TrainingMediaType | undefined;
}) {
  return studioToggleAvailable && (!features.audioTraining || mediaType === 'audio');
}

export function disabledMediaTooltip(mediaType: TrainingMediaType) {
  return mediaType === 'audio'
    ? 'Audio training is part of the new Training Studio (Beta)'
    : 'Temporarily disabled - check back soon!';
}
