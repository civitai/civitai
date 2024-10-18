import { Divider, Text, ActionIcon, Button, Badge } from '@mantine/core';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';
import React from 'react';
import { isDefined } from '~/utils/type-guards';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { BaseModelSetType } from '~/server/common/constants';

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
  const { meta, generationProcess, resources = [] } = data ?? {};
  const baseModel = getBaseModelFromResources(resources);

  if (!meta) return null;
  const { comfy, remixedFromImageId } = meta;

  const onSite = 'civitaiResources' in meta;
  const software = meta.software ?? (onSite ? 'Civitai Generator' : 'External Generator');

  let hasControlNet = Object.keys(meta).some((x) => x.toLowerCase().startsWith('controlnet'));
  if (meta.comfy) {
    hasControlNet = !!meta.controlNets?.length;
  }

  function getSimpleMetaContent(key: SimpleMetaPropsKey) {
    if (!meta) return null;
    switch (key) {
      case 'comfy':
        return comfy ? (
          <CopyButton value={() => JSON.stringify(comfy.workflow)}>
            {({ copy, copied, Icon, color }) => (
              <Button
                color={color}
                size="xs"
                compact
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
        return <Text className="leading-snug">{meta[key]}</Text>;
    }
  }

  const metaRemoved = removeUnrelated(baseModel, meta);
  const simpleMeta = Object.entries(simpleMetaProps)
    .filter(([key]) => metaRemoved[key as SimpleMetaPropsKey])
    .map(([key, label]) => {
      const content = getSimpleMetaContent(key as SimpleMetaPropsKey);
      if (!content) return null;
      return { label, content };
    })
    .filter(isDefined);

  const hasSimpleMeta = !!simpleMeta.length;

  return (
    <>
      {meta.prompt && (
        <div className="flex flex-col">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-1">
              <Text className="text-lg font-semibold">Prompt</Text>
              <Badge size="xs" radius="sm">
                {software}
              </Badge>
              <Badge size="xs" radius="sm">
                {meta.comfy
                  ? 'Comfy'
                  : generationProcess === 'txt2imgHiRes'
                    ? 'txt2img + Hi-Res'
                    : generationProcess}
                {hasControlNet && ' + ControlNet'}
              </Badge>
            </div>
            <CopyButton value={meta.prompt}>
              {({ copy, Icon, color }) => (
                <ActionIcon onClick={copy} color={color}>
                  <Icon size={16} />
                </ActionIcon>
              )}
            </CopyButton>
          </div>
          <LineClamp color="dimmed" className="text-sm">
            {meta.prompt}
          </LineClamp>
        </div>
      )}
      {meta.negativePrompt && (
        <div className="flex flex-col">
          <div className="flex items-center justify-between">
            <Text className="font-semibold">Negative prompt</Text>
            <CopyButton value={meta.negativePrompt}>
              {({ copy, Icon, color }) => (
                <ActionIcon onClick={copy} color={color}>
                  <Icon size={16} />
                </ActionIcon>
              )}
            </CopyButton>
          </div>
          <LineClamp color="dimmed" className="text-sm">
            {meta.negativePrompt}
          </LineClamp>
        </div>
      )}
      {hasSimpleMeta && (
        <>
          {(meta.prompt || meta.negativePrompt) && <Divider />}
          <div className="flex flex-col">
            <div className="flex items-center justify-between">
              <Text className="font-semibold">Other metadata</Text>
            </div>
            <div className="flex flex-wrap gap-2">
              {simpleMeta.map(({ label, content }) => (
                <Badge key={label} classNames={{ inner: 'flex gap-1 items-center' }}>
                  <span>{label}:</span>
                  {content}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}
      {/* TODO: trying out few render ux   */}
      {remixedFromImageId && (
        <div className="flex flex-col">
          <Text className="font-semibold">Remixed From Image ID</Text>
          <Text className="leading-snug">{remixedFromImageId}</Text>
        </div>
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
