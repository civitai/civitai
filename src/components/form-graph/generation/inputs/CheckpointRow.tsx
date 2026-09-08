import { Anchor, Button, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useResourceData } from '~/components/generation_v2/inputs/ResourceDataProvider';
import {
  getResourceStatus,
  getStatusClasses,
  isResourceDisabled,
  shouldShowModelLink,
} from '~/components/generation_v2/inputs/ResourceItemContent';
import {
  ResourceCardSkeleton,
  type PartialResourceValue,
} from '~/components/generation_v2/inputs/resource-select.utils';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getModelUrl } from '~/utils/string-helpers';

/**
 * The checkpoint as a single row: thumbnail, name, and one meta line reading
 * `version · ecosystem`.
 *
 * Replaces the 52px card the header used to spend on this. Everything the card
 * carried is still one click away in the picker.
 */
export function CheckpointRow({
  value,
  ecosystem,
  options,
  onOpenPicker,
  onRevertToDefault,
  disabled,
  locked,
}: {
  value?: PartialResourceValue;
  ecosystem?: string;
  options?: ResourceSelectOptions;
  onOpenPicker: () => void;
  onRevertToDefault?: () => void;
  disabled?: boolean;
  /**
   * The family pins its checkpoint — the version selector below is how you move
   * within it. The picker still opens: with the ecosystem rail living inside it,
   * hiding this button would strand you in the family with no way back out.
   */
  locked?: boolean;
}) {
  const { data: resource, isLoading } = useResourceData(value?.id);

  if (!value) {
    return (
      <Button variant="light" fullWidth onClick={onOpenPicker} disabled={disabled}>
        Select model
      </Button>
    );
  }

  if (!resource || isLoading) return <ResourceCardSkeleton />;

  const status = getResourceStatus(resource, options);
  const statusClasses = getStatusClasses(status);
  const unusable = isResourceDisabled(status);
  const ecosystemName = ecosystem ? ecosystemByKey.get(ecosystem)?.displayName : undefined;

  const meta = [resource.name, ecosystemName].filter(Boolean);

  const body = (
    <>
      {resource.image ? (
        <EdgeMedia
          src={resource.image.url}
          type={resource.image.type}
          width={64}
          className="size-8 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="size-8 shrink-0 rounded-md bg-gray-3 dark:bg-dark-4" />
      )}
      <span className="min-w-0 flex-1 text-left">
        {/* Same anchor the old model card used, via ResourceItemContent: a
            Mantine `Anchor` so it carries the theme's link colour, sized to its
            text so the hit area is the name and not the whole row. A private
            model someone else owns has no page to link to. */}
        {shouldShowModelLink(resource) ? (
          <Anchor
            href={getModelUrl({
              modelId: resource.model.id,
              modelName: resource.model.name,
              modelVersionId: resource.id,
            })}
            target="_blank"
            size="sm"
            fw={600}
            className="block w-fit max-w-full truncate"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {resource.model.name}
          </Anchor>
        ) : (
          <Text size="sm" fw={600} className="truncate">
            {resource.model.name}
          </Text>
        )}
        <Text size="xs" c="dimmed" lineClamp={1}>
          {meta.join(' · ')}
        </Text>
      </span>
    </>
  );

  const className = clsx(
    'flex w-full items-center gap-2.5 rounded-lg border border-gray-3 p-2 dark:border-dark-4',
    'bg-gray-0 dark:bg-dark-6',
    statusClasses.border,
    statusClasses.background
  );

  return (
    <div className={className}>
      {body}
      {unusable && onRevertToDefault && (
        <Button variant="light" size="compact-xs" radius="xl" onClick={onRevertToDefault}>
          Default
        </Button>
      )}
      <Button
        variant="subtle"
        size="compact-sm"
        onClick={onOpenPicker}
        disabled={disabled}
        rightSection={<IconChevronRight size={14} />}
        className="shrink-0"
      >
        {locked ? 'Change family' : 'Change'}
      </Button>
    </div>
  );
}
