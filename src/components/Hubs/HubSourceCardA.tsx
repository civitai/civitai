import { ActionIcon, Switch, Text, Tooltip } from '@mantine/core';
import { IconFolder, IconLayersSubtract, IconPackage, IconUser, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

export type HubSourceCardProps = {
  source: {
    type: UserHubSourceType;
    targetId: number;
    alias?: string | null;
    enabled: boolean;
    index: number;
  };
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
};

const sourceMeta: Record<UserHubSourceType, { label: string; Icon: typeof IconUser }> = {
  [UserHubSourceType.User]: { label: 'Creator', Icon: IconUser },
  [UserHubSourceType.Model]: { label: 'Model', Icon: IconPackage },
  [UserHubSourceType.ModelVersion]: { label: 'Version', Icon: IconLayersSubtract },
  [UserHubSourceType.Collection]: { label: 'Collection', Icon: IconFolder },
};

export function HubSourceCardA({ source, disabled, onToggle, onRemove }: HubSourceCardProps) {
  const { label, Icon } = sourceMeta[source.type];
  const name = source.alias ?? `#${source.targetId}`;

  return (
    <div
      className={clsx(
        'group flex h-8 items-center gap-2 rounded px-1.5',
        'hover:bg-gray-1 dark:hover:bg-dark-6',
        disabled && 'pointer-events-none opacity-60'
      )}
    >
      <Tooltip label={label} openDelay={400} withinPortal>
        <Icon
          size={15}
          stroke={1.7}
          className={clsx(
            'shrink-0',
            source.enabled ? 'text-gray-6 dark:text-dark-1' : 'text-gray-5 dark:text-dark-3'
          )}
        />
      </Tooltip>

      <Tooltip label={`${label} · ${name}`} openDelay={600} withinPortal>
        <Text
          size="sm"
          lineClamp={1}
          className={clsx(
            'min-w-0 flex-1 leading-none',
            !source.enabled && 'text-gray-6 dark:text-dark-2'
          )}
        >
          {name}
        </Text>
      </Tooltip>

      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        disabled={disabled}
        aria-label={`Remove ${name}`}
        className="shrink-0 opacity-0 transition-opacity hover:text-red-6 group-focus-within:opacity-100 group-hover:opacity-100 dark:hover:text-red-5"
        onClick={onRemove}
      >
        <IconX size={14} />
      </ActionIcon>

      <Switch
        size="xs"
        checked={source.enabled}
        disabled={disabled}
        aria-label={`${source.enabled ? 'Hide' : 'Show'} ${name} in this hub`}
        className="shrink-0"
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
    </div>
  );
}
