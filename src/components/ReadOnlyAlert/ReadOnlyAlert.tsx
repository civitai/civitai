import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Alert, Text } from '@mantine/core';
import {
  IconWorldExclamation,
} from '@tabler/icons-react';
import { openReadOnlyModal } from '~/components/Dialog/dialog-registry';
import { NextLink as Link } from '~/components/NextLink/NextLink';


export const ReadOnlyAlert = ({message}: { message?: string }) => {
  const features = useFeatureFlags();

  if (features.canWrite) {
    return null;
  }

  return (
    <Alert
      color="yellow"
      title="Read-only Mode"
    >
      <Text>
          {message ?? 'Civitai is currently in read-only mode and you won\'t be able to make changes.'}{' '}
          <Text
            component="span"
            variant="link"
            style={{ cursor: 'pointer', }}
            color="yellow.8"
            onClick={openReadOnlyModal}
          >
            Learn More
          </Text>

      </Text>

    </Alert>
  );
}

