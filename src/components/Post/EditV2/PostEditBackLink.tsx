import { Anchor } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getModelUrl } from '~/utils/string-helpers';

export function PostEditBackLink({
  modelId,
  modelVersionId,
  modelName,
}: {
  modelId: number | null;
  modelVersionId: number | null;
  modelName: string | null;
}) {
  if (!modelId || !modelVersionId || !modelName) return null;

  return (
    <Anchor
      component={Link}
      href={getModelUrl({ modelId, modelVersionId })}
      size="sm"
      c="dimmed"
      className="flex max-w-full items-center gap-1 self-start"
    >
      <IconArrowLeft size={14} className="shrink-0" />
      <span className="truncate">{modelName}</span>
    </Anchor>
  );
}
