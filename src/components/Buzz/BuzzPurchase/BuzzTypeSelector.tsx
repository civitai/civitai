import { Button, Group, Stack, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import React from 'react';

export interface BuzzTypeSelectorProps {
  onSelect: (type: 'green' | 'red') => void;
  onCancel?: () => void;
}

export function BuzzTypeSelector({ onSelect, onCancel }: BuzzTypeSelectorProps) {
  return (
    <Stack align="center" justify="center" gap="md">
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
        <div className="flex w-full max-w-md flex-col gap-6 sm:flex-row sm:gap-0 sm:divide-x sm:divide-gray-200 dark:sm:divide-gray-800">
          <div className="flex flex-1 flex-col items-center px-4">
            <div className="flex w-full flex-col items-center rounded-xl border border-gray-200 bg-gray-50 p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800">
              <Button
                size="lg"
                color="green"
                radius="xl"
                onClick={() => onSelect('green')}
                leftSection={<IconBolt color="#fff" stroke={1.5} />}
                data-testid="buzz-type-green"
                className="w-full min-w-[140px] bg-gradient-to-r from-green-500 to-emerald-400 px-6 py-4 text-lg font-bold shadow transition-all duration-150 hover:from-green-600 hover:to-emerald-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                aria-label="Buy Green Buzz"
              >
                Green Buzz
              </Button>
              <Text size="sm" className="mt-3 text-center text-green-700 dark:text-green-200">
                Can be purchased using <b>credit cards</b>.<br />
                Can <b>only</b> be used to generate <b>safe for work</b> content.
              </Text>
            </div>
          </div>
          <div className="mt-6 flex flex-1 flex-col items-center px-4 sm:mt-0">
            <div className="flex w-full flex-col items-center rounded-xl border border-gray-200 bg-gray-50 p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800">
              <Button
                size="lg"
                color="red"
                radius="xl"
                onClick={() => onSelect('red')}
                leftSection={<IconBolt color="#fff" stroke={1.5} />}
                data-testid="buzz-type-red"
                className="w-full min-w-[140px] bg-gradient-to-r from-rose-500 to-pink-400 px-6 py-4 text-lg font-bold shadow transition-all duration-150 hover:from-rose-600 hover:to-pink-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                aria-label="Buy Red Buzz"
              >
                Red Buzz
              </Button>
              <Text size="sm" className="mt-3 text-center text-red-700 dark:text-red-200">
                Can <b>only</b> be purchased using <b>crypto</b>.<br />
                Can be used to generate <b>NSFW</b> content as well as anything else on the site.
              </Text>
            </div>
          </div>
        </div>
      </Group>
      {onCancel && (
        <Button
          variant="light"
          color="gray"
          onClick={onCancel}
          radius="xl"
          className="mt-6 border border-gray-300 px-8 py-2 text-base font-medium transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          Cancel
        </Button>
      )}
    </Stack>
  );
}
