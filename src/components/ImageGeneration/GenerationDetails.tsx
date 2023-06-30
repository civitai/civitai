import { Accordion, Text } from '@mantine/core';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { Generation } from '~/server/services/generation/generation.types';
import { getDisplayName, titleCase } from '~/utils/string-helpers';

export function GenerationDetails({ params, label, upsideDown, ...descriptionTableProps }: Props) {
  const detailItems = Object.entries(params).map(([key, value]) => ({
    label: titleCase(getDisplayName(key)),
    value: (
      <ContentClamp maxHeight={44} labelSize="xs">
        {value as string}
      </ContentClamp>
    ),
  }));

  return (
    <Accordion
      variant="filled"
      styles={(theme) => ({
        content: {
          padding: 0,
        },
        item: {
          overflow: 'hidden',
          background: 'transparent',
        },
        control: {
          padding: 6,
          paddingLeft: theme.spacing.xs + 6,
          paddingRight: theme.spacing.xs + 6,
        },

        chevron: upsideDown
          ? {
              transform: 'rotate(180deg)',
              '&[data-rotate]': { transform: 'rotate(0deg)' },
            }
          : undefined,
      })}
    >
      <Accordion.Item value="details">
        <Accordion.Control>
          <Text size="sm" weight={500}>
            {label}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <DescriptionTable {...descriptionTableProps} items={detailItems} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

type Props = Omit<DescriptionTableProps, 'items'> & {
  label: string;
  params: Partial<Generation.Params>;
  upsideDown?: boolean;
};
