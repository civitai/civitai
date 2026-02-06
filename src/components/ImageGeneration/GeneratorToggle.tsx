/**
 * GeneratorToggle
 *
 * Banner component that allows users to switch between the legacy and new generator.
 * Shows different messages based on which generator the user is currently using.
 */

import { Alert, Button, Group, Text, CloseButton } from '@mantine/core';
import { IconSparkles, IconArrowBack } from '@tabler/icons-react';
import { useLocalStorage } from '@mantine/hooks';

import { useLegacyGeneratorStore } from '~/store/legacy-generator.store';

// =============================================================================
// Constants
// =============================================================================

const DISMISS_KEY = 'dismiss-generator-toggle-banner';

// =============================================================================
// Component
// =============================================================================

export function GeneratorToggleBanner() {
  const { useLegacy, switchToNew, switchToLegacy, hasExplicitPreference } =
    useLegacyGeneratorStore();
  const [dismissed, setDismissed] = useLocalStorage({
    key: DISMISS_KEY,
    defaultValue: false,
  });

  // Don't show if user explicitly chose and dismissed
  if (dismissed && hasExplicitPreference) return null;

  if (useLegacy) {
    // Legacy user - show banner to try new generator
    return (
      <Alert
        color="blue"
        className="mx-3 mb-2"
        icon={<IconSparkles size={18} />}
        withCloseButton
        onClose={() => setDismissed(true)}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm">
            Try the <strong>new generator</strong> with improved workflows and better performance!
          </Text>
          <Button
            size="compact-sm"
            variant="light"
            color="blue"
            onClick={() => {
              switchToNew();
            }}
            leftSection={<IconSparkles size={14} />}
          >
            Try it
          </Button>
        </Group>
      </Alert>
    );
  }

  // New generator user - show small option to go back (only if they haven't dismissed)
  if (!dismissed) {
    return (
      <div className="mx-3 mb-2 flex items-center justify-end">
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={switchToLegacy}
          leftSection={<IconArrowBack size={12} />}
        >
          Switch to classic generator
        </Button>
        <CloseButton size="xs" onClick={() => setDismissed(true)} />
      </div>
    );
  }

  return null;
}

// =============================================================================
// Settings Toggle (for use in settings or footer)
// =============================================================================

export function GeneratorSettingsToggle() {
  const { useLegacy, toggle } = useLegacyGeneratorStore();

  return (
    <Button size="compact-xs" variant="subtle" color="gray" onClick={toggle}>
      {useLegacy ? 'Switch to new generator' : 'Switch to classic generator'}
    </Button>
  );
}
