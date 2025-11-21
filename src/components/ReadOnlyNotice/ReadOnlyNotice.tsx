import { Button, Popover, Text } from '@mantine/core';
import { openReadOnlyModal } from '~/components/Dialog/triggers/read-only';
import { IconWorldExclamation } from '@tabler/icons-react';

export const ReadOnlyNotice = () => {
  return (
    <Popover withArrow width={300}>
      <Popover.Target>
        <Button
          className="relative z-10 cursor-pointer px-2"
          variant="outline"
          color="yellow"
          radius="xl"
        >
          <IconWorldExclamation size={18} strokeWidth={2.5} />
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Text c="yellow">We&rsquo;re in Read-only Mode</Text>
        <Text size="xs">
          Things like publishing, comments, and submitting bounties are currently disabled.
        </Text>
        <Button
          size="compact-xs"
          color="yellow"
          variant="light"
          mt="xs"
          fullWidth
          onClick={openReadOnlyModal}
        >
          More Details
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
};
