import { Badge, Card, Group, Popover, Stack, Switch, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { EXPERIMENTAL_MODE_SUPPORTED_MODELS } from '~/shared/constants/generation.constants';
import { getBaseModelGroup } from '~/shared/constants/base-model.constants';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { withController } from '~/libs/form/hoc/withController';

type ExperimentalModeCardProps = {
  value?: boolean;
  onChange?: (enabled: boolean) => void;
  baseModel?: string;
  workflow?: string;
};

export function ExperimentalModeCard({
  value,
  onChange,
  baseModel,
  workflow,
}: ExperimentalModeCardProps) {
  // Check if experimental mode is available
  const baseModelGroup = baseModel ? getBaseModelGroup(baseModel) : undefined;
  const isSupported =
    workflow === 'txt2img' && // Text-to-image workflow only
    baseModelGroup &&
    EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(baseModelGroup);

  if (!isSupported) {
    return null;
  }

  const now = new Date().getTime();
  const blueBuzzRewardedDate = new Date('10/02/2025').getTime();

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <Switch
            checked={value ?? false}
            onChange={(event) => onChange?.(event.currentTarget.checked)}
            label={
              <Text fw={500} size="sm">
                Experimental Mode
              </Text>
            }
          />

          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
            {`We're testing out a new generation engine that we're hoping will increase generation speed while retaining image quality.`}
          </InfoPopover>
        </Group>

        {now < blueBuzzRewardedDate && (
          <Popover width={300} withArrow withinPortal shadow="sm">
            <Popover.Target>
              <Badge
                leftSection={<IconSparkles size={14} />}
                variant="light"
                color="blue"
                style={{ cursor: 'pointer' }}
              >
                Earn Blue Buzz!
              </Badge>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  Blue Buzz Rewards
                </Text>
                <Text size="xs" lh={1.3}>
                  {`On October 1, we'll tally up all the images you generated in Experimental Mode, and you'll receive 1 Blue Buzz for each image.`}
                </Text>
              </Stack>
            </Popover.Dropdown>
          </Popover>
        )}
      </Group>
    </Card>
  );
}

export const InputExperimentalMode = withController(ExperimentalModeCard, ({ field }) => ({
  value: field.value,
}));
