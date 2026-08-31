import type { AlertProps } from '@mantine/core';
import { List, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { getBaseModelWarning } from '~/shared/constants/base-model-warnings.constants';

export function BaseModelWarningAlert({
  baseModel,
  ...alertProps
}: { baseModel: string | null | undefined } & Omit<AlertProps, 'children' | 'title'>) {
  const warning = getBaseModelWarning(baseModel);
  if (!warning) return null;

  return (
    <AlertWithIcon
      icon={<IconAlertTriangle size={20} />}
      iconColor="red"
      color="red"
      size="sm"
      title={warning.title}
      {...alertProps}
    >
      <List size="sm" spacing={4} mt={4}>
        {warning.points.map((point) => (
          <List.Item key={point}>
            <Text size="sm">{point}</Text>
          </List.Item>
        ))}
      </List>
    </AlertWithIcon>
  );
}
