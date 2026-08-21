import { ActionIcon, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconBox,
  IconLayoutGrid,
  IconTrash,
  IconUser,
  IconVersions,
  IconVolumeOff,
} from '@tabler/icons-react';
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

const sourceLabels: Record<UserHubSourceType, string> = {
  [UserHubSourceType.User]: 'Creator',
  [UserHubSourceType.Model]: 'Model',
  [UserHubSourceType.ModelVersion]: 'Version',
  [UserHubSourceType.Collection]: 'Collection',
};

const sourceIcons: Record<UserHubSourceType, typeof IconUser> = {
  [UserHubSourceType.User]: IconUser,
  [UserHubSourceType.Model]: IconBox,
  [UserHubSourceType.ModelVersion]: IconVersions,
  [UserHubSourceType.Collection]: IconLayoutGrid,
};

export function HubSourceCardC({ source, disabled, onToggle, onRemove }: HubSourceCardProps) {
  const name = source.alias ?? `#${source.targetId}`;
  const label = sourceLabels[source.type];
  const Icon = sourceIcons[source.type];

  return (
    <div className="group relative">
      <UnstyledButton
        role="switch"
        aria-checked={source.enabled}
        aria-label={`${source.enabled ? 'Mute' : 'Unmute'} ${name}`}
        disabled={disabled}
        onClick={() => onToggle(!source.enabled)}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md border border-solid py-1.5 pl-2 pr-9 transition-colors',
          disabled && 'pointer-events-none opacity-60',
          source.enabled
            ? 'border-blue-4 bg-blue-0 hover:bg-blue-1 dark:border-blue-8 dark:bg-dark-5 dark:hover:bg-dark-4'
            : 'border-dashed border-gray-3 bg-gray-0 hover:bg-gray-1 dark:border-dark-4 dark:bg-dark-7 dark:hover:bg-dark-6'
        )}
      >
        <div
          className={clsx(
            'flex size-6 shrink-0 items-center justify-center rounded-full',
            source.enabled
              ? 'bg-blue-6 text-white dark:bg-blue-8'
              : 'bg-gray-2 text-gray-6 dark:bg-dark-4 dark:text-dark-2'
          )}
        >
          {source.enabled ? <Icon size={14} /> : <IconVolumeOff size={14} />}
        </div>

        <div className="flex min-w-0 flex-col items-start">
          <Text
            size="sm"
            fw={500}
            lineClamp={1}
            className={clsx(
              'max-w-full break-all',
              !source.enabled && 'text-gray-6 dark:text-dark-2'
            )}
          >
            {name}
          </Text>
          <Text size="xs" className="text-gray-6 dark:text-dark-2">
            {source.enabled ? label : `${label} · Muted`}
          </Text>
        </div>
      </UnstyledButton>

      <Tooltip label="Remove from hub" withinPortal>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="red"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
