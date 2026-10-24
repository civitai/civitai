import { ActionIcon, Badge, Group, ScrollArea, Text } from '@mantine/core';
import { IconBrush, IconCube } from '@tabler/icons-react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ChallengeDetail } from '~/server/schema/challenge.schema';
import { getModelUrl } from '~/utils/string-helpers';

export type EligibleModel = ChallengeDetail['models'][number];

export function EligibleModelsList({
  models,
  onGenerate,
  canGenerate = () => true,
}: {
  models: EligibleModel[];
  /** Adds a generate button to each model `canGenerate` allows. */
  onGenerate?: (model: EligibleModel) => void;
  canGenerate?: (model: EligibleModel) => boolean;
}) {
  return (
    <ScrollArea.Autosize mah={300}>
      {models.map((m) => (
        <div
          key={m.versionId}
          className="flex items-center gap-3 px-3 py-2 hover:bg-gray-1 dark:hover:bg-dark-5"
        >
          <Link
            href={getModelUrl({ modelId: m.id, modelName: m.name, modelVersionId: m.versionId })}
            className="flex min-w-0 flex-1 items-center gap-3 no-underline"
            target="_blank"
          >
            {m.image ? (
              <ImageGuard2 image={m.image} explain={false}>
                {(safe) => (
                  <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-gray-2 dark:bg-dark-3">
                    {safe ? (
                      <EdgeMedia2
                        src={m.image!.url}
                        width={96}
                        type={m.image!.type}
                        className="size-full object-cover"
                      />
                    ) : (
                      <MediaHash {...m.image!} />
                    )}
                  </div>
                )}
              </ImageGuard2>
            ) : (
              <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-gray-2 dark:bg-dark-3">
                <IconCube size={20} className="text-dimmed" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <Text size="sm" fw={500} lineClamp={1}>
                {m.name}
              </Text>
              <Group gap={4} wrap="nowrap">
                <Badge size="xs" variant="light">
                  {m.baseModel}
                </Badge>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {m.versionName}
                </Text>
              </Group>
            </div>
          </Link>
          {onGenerate && canGenerate(m) && (
            <ActionIcon
              variant="subtle"
              color="blue"
              size="md"
              onClick={() => onGenerate(m)}
              aria-label={`Generate with ${m.name}`}
            >
              <IconBrush size={16} />
            </ActionIcon>
          )}
        </div>
      ))}
    </ScrollArea.Autosize>
  );
}
