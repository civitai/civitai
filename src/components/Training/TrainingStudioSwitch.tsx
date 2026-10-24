import { Anchor, Button, Group, Text } from '@mantine/core';
import { IconBarbell, IconSparkles } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { isStudioToggleAvailable } from '~/components/Training/Form/studioAudioNotice';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
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

export function SwitchToTrainingStudioAlert({
  destination,
  children,
}: {
  destination: string;
  children?: ReactNode;
}) {
  const canSwitch = useCanSwitchToTrainingStudio();
  const { switchTo, switching } = useTrainingStudioSwitch();
  if (!canSwitch) return null;

  return (
    <AlertWithIcon icon={<IconBarbell size={16} />} iconColor="blue" color="blue" size="sm">
      <Group gap="sm">
        <Text size="sm">
          {children ?? (
            <>
              <b>Training Studio</b> is our new training experience — a redesigned flow for image
              and video, plus audio training.
            </>
          )}{' '}
          This classic trainer will be phased out gradually as Training Studio matures. For now you
          can switch back at any time.
        </Text>
        <Button size="compact-sm" loading={switching} onClick={() => switchTo(true, destination)}>
          Switch to Training Studio
        </Button>
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
        {names} LoRAs train only in our new <b>Training Studio</b> (Beta).{' '}
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
          You&rsquo;re using the new <b>Training Studio</b>. The classic trainer is still here for
          your drafts, or if you prefer it, but it will be phased out gradually as Training Studio
          matures.
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
