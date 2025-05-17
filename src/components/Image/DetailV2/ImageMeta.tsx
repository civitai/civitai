import { Divider, Text, ActionIcon, Button, Badge } from '@mantine/core';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';
import React from 'react';
import { isDefined } from '~/utils/type-guards';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { BaseModelSetType } from '~/server/common/constants';
import { getVideoGenerationConfig } from '~/server/orchestrator/generation/generation.config';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
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
  const { meta, resources = [], onSite, process } = data ?? {};
  const baseModel = getBaseModelFromResources(resources);

  if (!meta) return null;
  const { comfy } = meta;

  const software = meta.software ?? (onSite ? 'Civitai Generator' : 'External Generator');

  function getSimpleMetaContent(key: SimpleMetaPropsKey) {
    if (!meta) return null;
    switch (key) {
      case 'comfy':
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
      default:
        return typeof meta[key] !== 'object' ? <span>{meta[key]}</span> : null;
    }
  }

  const { prompt, negativePrompt, ...restMeta } = meta;

  function getSimpleMeta() {
    if (!data) return [];
    if (data.type === 'image') {
      const metaRemoved = removeUnrelated(baseModel, restMeta);
      return Object.entries(simpleMetaProps)
        .filter(([key]) => metaRemoved[key as SimpleMetaPropsKey])
        .map(([key, label]) => {
          const content = getSimpleMetaContent(key as SimpleMetaPropsKey);
          if (!content) return null;
          return { label, content };
        })
        .filter(isDefined);
    } else if (data.type === 'video') {
      const config = getVideoGenerationConfig((meta as any).engine);
      if (!config) return [];
      return (
        config.metadataDisplayProps?.map((key) => ({
          label: key,
          content: getSimpleMetaContent(key as SimpleMetaPropsKey),
        })) ?? []
      );
    } else {
      return [];
    }
  }

  const simpleMeta = getSimpleMeta();

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
