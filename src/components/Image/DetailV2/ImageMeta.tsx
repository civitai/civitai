import { Divider, Text, Badge, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useMemo } from 'react';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useMetadataCopy } from '~/hooks/useMetadataCopy';
import { trpc } from '~/utils/trpc';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { getVideoGenerationConfig } from '~/server/orchestrator/generation/generation.config';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';

const simpleMetaProps = {
  comfy: 'Workflow',
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  clipSkip: 'Clip skip',
} as const;

export function ImageMeta({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const { meta, onSite, process } = data ?? {};
  const { copy: copyAll, copied: copiedAll } = useMetadataCopy(meta);
  // const baseModel = getBaseModelFromResources(resources);

  const simpleMeta = useMemo(() => {
    if (!data) return null;

    const meta: Record<string, any> = data.meta ?? {};
    const resources = data.resources ?? [];

    if (!meta) return null;
    const { prompt, negativePrompt, ...restMeta } = meta;
    const baseModel = getBaseModelFromResources(resources);

    const keys: string[] = [];
    if (data.type === 'image') {
      const metaRemoved = baseModel ? removeUnrelated(baseModel, restMeta) : restMeta;
      const filteredKeys = Object.keys(simpleMetaProps).filter((key) => metaRemoved[key]);

      for (const key of filteredKeys) {
        if (meta[key]) keys.push(key);
      }
    } else if (data.type === 'video') {
      const config = getVideoGenerationConfig((meta as any).engine);
      if (config) {
        for (const key of config.metadataDisplayProps) {
          if (meta[key]) keys.push(key);
        }
      }
    }

    function getSimpleMetaContent(key: string) {
      if (!meta) return null;
      switch (key) {
        case 'comfy':
          const comfy = meta['comfy'];
          const nodeCount: number = comfy?.workflow?.nodes?.length ?? 0;
          const nodeText =
            nodeCount === 1 ? `${nodeCount} Node` : `${nodeCount > 0 ? nodeCount : ''} Nodes`;

          return comfy ? (
            <CopyButton value={() => JSON.stringify(comfy.workflow)}>
              {({ copy, copied, Icon, color }) => (
                <UnstyledButton
                  className={clsx('flex items-center gap-1 rounded-lg', color && 'text-teal-500')}
                  onClick={copy}
                >
                  {!copied ? nodeText.trim() : 'Copied'}
                  <Icon size={14} />
                </UnstyledButton>
              )}
            </CopyButton>
          ) : null;
        default: {
          const content = meta[key];
          if (!content || typeof content === 'object') return null;
          return <span>{content}</span>;
        }
      }
    }

    return keys.map((key) => ({ label: key, content: getSimpleMetaContent(key) }));
  }, [data]);

  if (!meta || !simpleMeta) return null;

  const software = meta.software ?? (onSite ? 'Civitai Generator' : 'External Generator');
  const { prompt, negativePrompt } = meta;
  const hasSimpleMeta = !!simpleMeta.length;

  return (
    <>
      {prompt ? (
        <div className="flex flex-col">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-1">
              <Text className="text-lg font-semibold">Prompt</Text>
              <Badge size="xs" radius="sm">
                {software}
              </Badge>
              <Badge size="xs" radius="sm">
                {process}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <CopyButton value={prompt}>
                {({ copy, Icon, color }) => (
                  <LegacyActionIcon onClick={copy} color={color}>
                    <Icon size={16} />
                  </LegacyActionIcon>
                )}
              </CopyButton>
              <Tooltip label={copiedAll ? 'Copied' : 'Copy all metadata'} withArrow>
                <LegacyActionIcon onClick={copyAll} color={copiedAll ? 'teal' : undefined}>
                  {copiedAll ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </LegacyActionIcon>
              </Tooltip>
            </div>
          </div>
          <LineClamp c="dimmed" className="text-sm">
            {prompt}
          </LineClamp>
        </div>
      ) : (
        <div className="flex gap-1">
          <Badge size="xs" radius="sm">
            {software}
          </Badge>
          <Badge size="xs" radius="sm">
            {process}
          </Badge>
        </div>
      )}
      {negativePrompt && (
        <div className="flex flex-col">
          <div className="flex items-center justify-between">
            <Text className="font-semibold">Negative prompt</Text>
            <CopyButton value={negativePrompt}>
              {({ copy, Icon, color }) => (
                <LegacyActionIcon onClick={copy} color={color}>
                  <Icon size={16} />
                </LegacyActionIcon>
              )}
            </CopyButton>
          </div>
          <LineClamp c="dimmed" className="text-sm">
            {negativePrompt}
          </LineClamp>
        </div>
      )}
      {hasSimpleMeta && (
        <>
          <Divider />
          <div className="flex flex-col">
            <div className="flex items-center justify-between">
              <Text className="font-semibold">Other metadata</Text>
            </div>
            <div className="flex flex-wrap gap-2">
              {simpleMeta.map(({ label, content }) => (
                <Badge key={label} classNames={{ label: 'flex gap-1 items-center leading-snug' }}>
                  <span>{label}:</span>
                  {content}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function removeUnrelated<T extends Record<string, unknown>>(baseModel: BaseModelGroup, data: T) {
  let keys: string[] = [];
  switch (baseModel) {
    case 'Flux1':
      keys = ['clipSkip', 'sampler'];
      break;
    default:
      break;
  }

  if (keys.length) {
    return Object.entries(data).reduce<T>((acc, [key, val]) => {
      if (!keys.includes(key)) return { ...acc, [key]: val };
      return acc;
    }, {} as T);
  }

  return data;
}
