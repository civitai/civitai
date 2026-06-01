/**
 * MissingPreprocessorExamplesAlert
 *
 * Moderator-only notice listing preprocessor kinds that have no valid example
 * output. A missing example almost always means the preprocessor is failing on
 * the orchestrator (misconfigured), so this doubles as a "needs a fix" reminder
 * for mods/devs. Renders nothing for non-moderators or when every kind has an
 * example.
 */
import { Alert, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getPreprocessKindsMissingExamples } from '~/shared/constants/controlnets.constants';

export function MissingPreprocessorExamplesAlert() {
  const currentUser = useCurrentUser();
  if (!currentUser?.isModerator) return null;

  const missing = getPreprocessKindsMissingExamples();
  if (missing.length === 0) return null;

  return (
    <Alert
      color="orange"
      radius="md"
      icon={<IconAlertTriangle size={16} />}
      title={`${missing.length} preprocessor${missing.length === 1 ? '' : 's'} missing an example`}
    >
      <Text size="xs">
        These preprocessors have no example output, which usually means they are failing on the
        orchestrator and need to be configured/fixed:
      </Text>
      <Text size="xs" fw={600} mt={4}>
        {missing.map((m) => m.label).join(', ')}
      </Text>
      <Text size="xs" c="dimmed" mt={4}>
        Visible to moderators only.
      </Text>
    </Alert>
  );
}
