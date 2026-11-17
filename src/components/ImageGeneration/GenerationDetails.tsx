import type { AccordionControlProps } from '@mantine/core';
import { Accordion, Text } from '@mantine/core';
import type { Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { getDisplayName, titleCase } from '~/utils/string-helpers';

/** The generation's parameters as a table, without the accordion around it. */
export function GenerationDetailsTable({
  params,
  ...descriptionTableProps
}: Omit<DescriptionTableProps, 'items'> & { params: Record<string, unknown> }) {
  const detailItems = Object.entries(params ?? {})
    .filter(([key, value]) => {
      if (Array.isArray(value) || typeof value === 'object' || key === 'priority') return false;
      if (typeof value === 'string') return !!value.length;
      return !!value;
    })
    .map(([key, value]) => {
      let _value = value;
      if (typeof _value === 'boolean') _value = _value ? 'true' : 'false';
      return {
        label: titleCase(getDisplayName(key)),
        value: _value as any,
      };
    });

  return <DescriptionTable {...descriptionTableProps} items={detailItems} />;
}

export function GenerationDetails({
  params,
  label,
  controlProps,
  ...descriptionTableProps
}: Props) {
  if (!params) return null;

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
          paddingLeft: theme.spacing.md,
          paddingRight: theme.spacing.md,
        },
      })}
    >
      <Accordion.Item value="details">
        <Accordion.Control {...controlProps}>
          <Text size="sm" fw={500}>
            {label}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <GenerationDetailsTable {...descriptionTableProps} params={params} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

type Props = Omit<DescriptionTableProps, 'items'> & {
  label: string;
  controlProps?: AccordionControlProps;
} & { params: Record<string, unknown> };
