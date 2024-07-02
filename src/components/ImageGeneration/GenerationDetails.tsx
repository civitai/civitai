import { Accordion, AccordionControlProps, Text } from '@mantine/core';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { NormalizedTextToImageParams } from '~/server/services/orchestrator';
import { getDisplayName, titleCase } from '~/utils/string-helpers';

export function GenerationDetails({
  params,
  label,
  upsideDown,
  controlProps,
  ...descriptionTableProps
}: Props) {
  const detailItems = Object.entries(params)
    .filter(([, value]) => {
      if (Array.isArray(value)) return false;
      if (typeof value === 'string') return !!value.length;
      return value !== undefined;
    })
    .map(([key, value]) => ({
      label: titleCase(getDisplayName(key)),
      value: <LineClamp lineClamp={2}>{`${value}`}</LineClamp>,
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
        <Accordion.Control {...controlProps}>
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
  params: Partial<NormalizedTextToImageParams>;
  upsideDown?: boolean;
  controlProps?: AccordionControlProps;
};
