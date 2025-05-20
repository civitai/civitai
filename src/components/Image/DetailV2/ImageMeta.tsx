import { Divider, Text, ActionIcon, Button, Badge } from '@mantine/core';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';
import React, { useMemo } from 'react';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { BaseModelSetType } from '~/server/common/constants';
import { getVideoGenerationConfig } from '~/server/orchestrator/generation/generation.config';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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

      for (const key of Object.keys(simpleMetaProps).filter((key) => metaRemoved[key])) {
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
          return comfy ? (
            <CopyButton value={() => JSON.stringify(comfy.workflow)}>
              {({ copy, copied, Icon, color }) => (
                <Button
                  color={color}
                  size="compact-xs"
                  className="rounded-lg"
                  classNames={{ label: 'flex items-center gap-1' }}
                  onClick={copy}
                >
                  {!copied ? 'Nodes' : 'Copied'}
                  <Icon size={16} />
                </Button>
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
            <CopyButton value={prompt}>
              {({ copy, Icon, color }) => (
                <LegacyActionIcon onClick={copy} color={color}>
                  <Icon size={16} />
                </LegacyActionIcon>
              )}
            </CopyButton>
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
                <Badge key={label} classNames={{ root: 'flex gap-1 items-center leading-snug' }}>
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

function removeUnrelated<T extends Record<string, unknown>>(baseModel: BaseModelSetType, data: T) {
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
