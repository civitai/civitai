import type { AlertProps } from '@mantine/core';
import { Alert } from '@mantine/core';
import { getBaseModelWarning } from '~/shared/constants/base-model-warnings.constants';

export function BaseModelWarningPoints({ points }: { points: string[] }) {
  return (
    <ul className="m-0 flex min-w-0 list-disc flex-col gap-1 pl-4 text-sm">
      {points.map((point) => (
        <li key={point} className="break-words">
          {point}
        </li>
      ))}
    </ul>
  );
}

export function BaseModelWarningAlert({
  baseModel,
  ...alertProps
}: { baseModel: string | null | undefined } & Omit<AlertProps, 'children' | 'title'>) {
  const warning = getBaseModelWarning(baseModel);
  if (!warning) return null;

  return (
    <Alert color="red" radius="sm" title={warning.title} {...alertProps}>
      <BaseModelWarningPoints points={warning.points} />
    </Alert>
  );
}
