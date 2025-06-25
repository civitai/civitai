import { Button, Group, Stack, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import React from 'react';

export interface BuzzTypeSelectorProps {
  onSelect: (type: 'green' | 'red') => void;
  onCancel?: () => void;
}

export function BuzzTypeSelector({ onSelect, onCancel }: BuzzTypeSelectorProps) {
  return (
    <Stack align="center" justify="center" py="xl" gap="md">
      <Text fw={700} fz={28} align="center" className="mb-2 text-gray-900 dark:text-gray-100">
        Choose which Buzz to buy
      </Text>
      <Text fz={16} align="center" className="mb-4 text-gray-700 dark:text-gray-300">
        We offer multiple types of Buzz for flexibility and control.
        <br />
        Pick the option that fits your needs—whether you want to keep things safe for work or unlock
        the platform&apos;s full creative potential. Each type is tailored for different content and
        payment preferences.
      </Text>
      <Group gap="lg" className="flex w-full justify-center">
        <div className="flex w-full max-w-md flex-col gap-4 sm:flex-row">
          <div className="flex flex-1 flex-col items-center">
            <Button
              size="lg"
              color="green"
              radius="xl"
              onClick={() => onSelect('green')}
              leftSection={<IconBolt color="#fff" stroke={1.5} />}
              data-testid="buzz-type-green"
              className="w-full min-w-[120px] px-4 py-3 text-lg font-semibold shadow-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
              aria-label="Buy Green Buzz"
            >
              Green Buzz
            </Button>
            <Text size="sm" className="mt-2 text-center text-green-700 dark:text-green-200">
              Can be purchased using <b>credit cards</b>.<br />
              Can <b>only</b> be used to generate <b>safe for work</b> content.
            </Text>
          </div>
          <div className="flex flex-1 flex-col items-center">
            <Button
              size="lg"
              color="red"
              radius="xl"
              onClick={() => onSelect('red')}
              leftSection={<IconBolt color="#fff" stroke={1.5} />}
              data-testid="buzz-type-red"
              className="w-full min-w-[120px] px-4 py-3 text-lg font-semibold shadow-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              aria-label="Buy Red Buzz"
            >
              Red Buzz
            </Button>
            <Text size="sm" className="mt-2 text-center text-red-700 dark:text-red-200">
              Can <b>only</b> be purchased using <b>crypto</b>.<br />
              Can be used to generate <b>NSFW</b> content as well as anything else on the site.
            </Text>
          </div>
        </div>
      </Group>
      {onCancel && (
        <Button variant="light" color="gray" onClick={onCancel} radius="xl" className="mt-2">
          Cancel
        </Button>
      )}
    </Stack>
  );
}
