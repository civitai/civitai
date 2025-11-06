import { Button, Group, Stack, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import React from 'react';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export interface BuzzTypeSelectorProps {
  onSelect: (type: BuzzSpendType) => void;
  onCancel?: () => void;
  title?: string | null;
  description?: React.ReactNode | null;
  greenButton?: {
    text?: string;
    description?: React.ReactNode;
  };
  yellowButton?: {
    text?: string;
    description?: React.ReactNode;
  };
}

export function BuzzTypeSelector({
  onSelect,
  onCancel,
  title = 'Choose which Buzz to buy',
  description = (
    <>
      We offer multiple types of Buzz for flexibility and control.
      <br />
      Pick the option that fits your needs—whether you want to keep things safe for work or unlock
      the platform&apos;s full creative potential. Each type is tailored for different content and
      payment preferences.
    </>
  ),
  greenButton = {
    text: 'Green Buzz',
    description: (
      <>
        Can be purchased using <b>credit cards</b>.<br />
        Can <b>only</b> be used to generate <b>safe for work</b> content on Civitai.green.
      </>
    ),
  },
  yellowButton = {
    text: 'Yellow Buzz',
    description: (
      <>
        Can be purchased using <b>Gift Cards or cryptocurrency</b>.<br />
        Can be used to generate <b>NSFW</b> content as well as anything else on the site. Can only
        be used in Civitai.com.
      </>
    ),
  },
}: BuzzTypeSelectorProps) {
  const { classNames: yellowClassNames } = useBuzzCurrencyConfig('yellow');
  const { classNames: greenClassNames } = useBuzzCurrencyConfig('green');

  return (
    <Stack align="center" justify="center" gap="md">
      {title && (
        <Text fw={700} fz={28} align="center" className="mb-2 text-gray-900 dark:text-gray-100">
          {title}
        </Text>
      )}
      {description && (
        <Text fz={16} align="center" className="mb-4 text-gray-700 dark:text-gray-300">
          {description}
        </Text>
      )}
      <Group gap="lg" className="flex w-full justify-center">
        <div className="flex w-full max-w-md flex-col gap-6 sm:flex-row sm:gap-0 sm:divide-x sm:divide-gray-200 dark:sm:divide-gray-800">
          <div className="flex flex-1 flex-col items-center px-4">
            <div className="flex size-full flex-col items-center rounded-xl border border-gray-200 bg-gray-50 p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800">
              <div className="flex w-full flex-col items-center">
                <Button
                  size="lg"
                  radius="xl"
                  onClick={() => onSelect('green')}
                  leftSection={<IconBolt color="#fff" stroke={1.5} />}
                  data-testid="buzz-type-green"
                  className={`w-full ${greenClassNames?.btn} px-6 py-4 text-lg`}
                  aria-label={greenButton.text}
                >
                  {greenButton.text}
                </Button>
              </div>
              <Text size="sm" className="mt-3 text-center text-green-700 dark:text-green-200">
                {greenButton.description}
              </Text>
            </div>
          </div>
          <div className="mt-6 flex flex-1 flex-col items-center px-4 sm:mt-0">
            <div className="flex size-full flex-col items-center rounded-xl border border-gray-200 bg-gray-50 p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800">
              <div className="flex w-full flex-col items-center">
                <Button
                  size="lg"
                  radius="xl"
                  onClick={() => onSelect('yellow')}
                  leftSection={<IconBolt color="#fff" stroke={1.5} />}
                  data-testid="buzz-type-yellow"
                  className={`w-full ${yellowClassNames?.btn} px-6 py-4 text-lg`}
                  aria-label={yellowButton.text}
                >
                  {yellowButton.text}
                </Button>
              </div>
              <Text size="sm" className="mt-3 text-center text-yellow-700 dark:text-yellow-200">
                {yellowButton.description}
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
