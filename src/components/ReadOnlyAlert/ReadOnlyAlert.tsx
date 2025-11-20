import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Alert, Text } from '@mantine/core';
import { openReadOnlyModal } from '~/components/Dialog/triggers/read-only';

export const ReadOnlyAlert = ({ message }: { message?: string }) => {
  const features = useFeatureFlags();

  if (features.canWrite) {
    return null;
  }

  return (
    <Alert color="yellow" title="Read-only Mode">
      <Text>
        {message ?? "Civitai is currently in read-only mode and you won't be able to make changes."}{' '}
        <Text
          component="span"
          style={{ cursor: 'pointer' }}
          c="yellow.8"
          onClick={openReadOnlyModal}
        >
          Learn More
        </Text>
      </Text>
    </Alert>
  );
};
