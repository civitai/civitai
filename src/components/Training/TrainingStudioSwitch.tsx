import { Anchor, Button, Group, Text } from '@mantine/core';
import { IconBarbell, IconSparkles } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { isStudioToggleAvailable } from '~/components/Training/Form/studioAudioNotice';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import {
  CLASSIC_TRAINER_RETIRES_AT,
  isClassicTrainerRetired,
} from '~/shared/constants/training.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useTrainingStudioSwitch() {
  const [switching, setSwitching] = useState(false);
  const { mutate } = trpc.user.toggleFeature.useMutation();

  function switchTo(studio: boolean, destination: string) {
    setSwitching(true);
    mutate(
      { feature: 'trainingStudioUi', value: studio },
      {
        // A full navigation, not a client transition: both trainers gate or redirect on this
        // flag, and a transition renders them against the stale value (NotFound, or a bounce back).
        onSuccess: () => window.location.assign(destination),
        onError: () => {
          setSwitching(false);
          showErrorNotification({
            title: 'Could not switch trainers',
            error: new Error('Something went wrong, please try again later.'),
          });
        },
      }
    );
  }

  return { switchTo, switching };
}

export function useCanSwitchToTrainingStudio() {
  const features = useFeatureFlags();
  const { data: userFeatures } = trpc.user.getFeatureFlags.useQuery(undefined, {
    gcTime: Infinity,
    staleTime: Infinity,
  });
  return isStudioToggleAvailable(userFeatures) && !features.trainingStudioUi;
}

const classicTrainerRetirementDate = `${formatDate(
  CLASSIC_TRAINER_RETIRES_AT,
  'MMMM D, YYYY',
  true
)} (00:00 UTC)`;

// Shown on every classic trainer page, including to users who can't switch: the retirement
// applies to them too.
export function SwitchToTrainingStudioAlert({
  destination,
  children,
}: {
  destination: string;
  children?: ReactNode;
}) {
  const canSwitch = useCanSwitchToTrainingStudio();
  const { switchTo, switching } = useTrainingStudioSwitch();
  const retired = isClassicTrainerRetired();

  return (
    <AlertWithIcon
      icon={<IconBarbell size={16} />}
      iconColor={retired ? 'red' : 'yellow'}
      color={retired ? 'red' : 'yellow'}
      size="sm"
    >
      <Group gap="sm">
        <Text size="sm">
          {children ?? (
            <>
              <b>Training Studio</b> is our new training experience — a redesigned flow for image
              and video, plus audio training.
            </>
          )}{' '}
          {retired ? (
            <>
              This classic trainer was retired on {classicTrainerRetirementDate} and no longer
              starts new runs. Your past runs stay here.
            </>
          ) : (
            <>
              This classic trainer will stop starting new runs on{' '}
              <b>{classicTrainerRetirementDate}</b>. Runs already submitted will finish, and your
              past runs stay here.
            </>
          )}
        </Text>
        {canSwitch && (
          <Button size="compact-sm" loading={switching} onClick={() => switchTo(true, destination)}>
            Switch to Training Studio
          </Button>
        )}
      </Group>
    </AlertWithIcon>
  );
}

// Models that train only in Training Studio, each behind the flag that shows its Studio card.
const STUDIO_ONLY_MODELS = [
  { name: 'Flux.3 Klein', feature: 'flux3KleinTraining' },
  { name: 'MOSS Image', feature: 'mossImageTraining' },
] as const satisfies readonly { name: string; feature: FeatureFlagKey }[];

export function StudioOnlyModelsNotice() {
  const features = useFeatureFlags();
  const canSwitch = useCanSwitchToTrainingStudio();
  const { switchTo, switching } = useTrainingStudioSwitch();
  const models = STUDIO_ONLY_MODELS.filter((model) => features[model.feature]);
  if (!canSwitch || !models.length) return null;

  const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    models.map((model) => model.name)
  );

  return (
    <DismissibleAlert
      // Keyed on the models shown, so a newly added one brings the notice back after a dismissal.
      id={`training-studio-only-${models.map((model) => model.feature).join('-')}`}
      color="blue"
      size="sm"
      icon={<IconSparkles size={16} />}
      title={`${names} ${models.length > 1 ? 'are' : 'is'} here — in Training Studio`}
    >
      <Text size="sm">
        {names} LoRAs train only in our new <b>Training Studio</b>.{' '}
        <Anchor
          component="button"
          type="button"
          size="sm"
          disabled={switching}
          onClick={() => switchTo(true, '/training-studio?view=new')}
        >
          Switch to Training Studio
        </Anchor>{' '}
        to try {models.length > 1 ? 'them' : 'it'}. You can switch back at any time.
      </Text>
    </DismissibleAlert>
  );
}

export function SwitchToClassicTrainerAlert({ destination }: { destination: string }) {
  const { switchTo, switching } = useTrainingStudioSwitch();

  return (
    <AlertWithIcon icon={<IconBarbell size={16} />} iconColor="blue" color="blue" size="sm" mb="md">
      <Group gap="sm">
        <Text size="sm">
          You&rsquo;re using the new <b>Training Studio</b>.{' '}
          {isClassicTrainerRetired() ? (
            <>
              The classic trainer was retired on {classicTrainerRetirementDate}; it still shows your
              past runs but can&rsquo;t start new ones.
            </>
          ) : (
            <>
              The classic trainer is still here for your drafts, but it will stop starting new runs
              on <b>{classicTrainerRetirementDate}</b>.
            </>
          )}
        </Text>
        <Button
          size="compact-sm"
          variant="default"
          loading={switching}
          onClick={() => switchTo(false, destination)}
        >
          Use the classic trainer
        </Button>
      </Group>
    </AlertWithIcon>
  );
}
