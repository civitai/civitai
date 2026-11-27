import { Divider, Text, Badge, UnstyledButton } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useMemo } from 'react';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useMetadataCopy } from '~/hooks/useMetadataCopy';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ImageMeta({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const { meta, onSite, process } = data ?? {};
  const { copy: copyAll, copied: copiedAll } = useMetadataCopy(meta);

  const simpleMeta = useMemo(() => {
    if (!data) return null;

    const meta: Record<string, any> = data.meta ?? {};
    if (!meta) return null;
    const { prompt, negativePrompt, ...restMeta } = meta;

    // On-site generations: the server resolves which keys are real generator
    // inputs via the generation graph (`displayKeys`). Off-site/foreign
    // metadata has no graph mapping, so show all of it.
    const candidateKeys =
      data.onSite && data.displayKeys ? data.displayKeys : Object.keys(restMeta);

    // The comfy workflow chip is display-only (not a graph input node) — always
    // surface it when present.
    const keySet = new Set(candidateKeys.filter((key) => key !== 'comfy'));
    if (restMeta.comfy) keySet.add('comfy');

    const keys = [...keySet].filter(
      (key) =>
        // prompt/negativePrompt render in their own sections, not as badges
        key !== 'prompt' &&
        key !== 'negativePrompt' &&
        // drop capitalized external-tool fields (A1111-style: Size, Model,
        // Schedule type, Unprompted, etc.)
        !/^[A-Z]/.test(key) &&
        meta[key] != null
    );

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
          // omit boolean values from badges
          if (!content || typeof content === 'object' || typeof content === 'boolean') return null;
          return <span>{content}</span>;
        }
      }
    }

    return keys
      .map((key) => ({ label: key, content: getSimpleMetaContent(key) }))
      .filter(({ content }) => content !== null);
  }, [data]);

  if (!meta || !simpleMeta) return null;
  if (data?.type === 'audio') return <SongMeta meta={meta} model={data.resources[0]} />;

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
                {({ copy, copied, Icon, color }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy prompt'}>
                    <LegacyActionIcon onClick={copy} color={color}>
                      <Icon size={16} />
                    </LegacyActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
              <Tooltip label={copiedAll ? 'Copied' : 'Copy all metadata'}>
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
              {({ copy, copied, Icon, color }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy negative prompt'}>
                  <LegacyActionIcon onClick={copy} color={color}>
                    <Icon size={16} />
                  </LegacyActionIcon>
                </Tooltip>
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

/**
 * A song's generation data: its style prompt and the settings that tell it apart. Lyrics show in
 * the player, and the generator's duration is a cap rather than the song's length, so neither is
 * listed; nor are the workflow and ecosystem keys, which the model name already says.
 */
export function SongMeta({
  meta,
  model,
}: {
  meta: Record<string, unknown>;
  model?: { modelName?: string | null; versionName?: string | null };
}) {
  const { copy: copyAll, copied: copiedAll } = useMetadataCopy(meta);
  const style = typeof meta.musicDescription === 'string' ? meta.musicDescription : undefined;
  const details = [
    {
      label: 'Model',
      // A song made on-site often has no resource row; its ecosystem names the model.
      value:
        [model?.modelName, model?.versionName].filter(Boolean).join(' ') ||
        (typeof meta.ecosystem === 'string'
          ? ecosystemByKey.get(meta.ecosystem)?.displayName
          : undefined),
    },
    {
      label: 'Seed',
      value:
        typeof meta.seed === 'number' || typeof meta.seed === 'string'
          ? String(meta.seed)
          : undefined,
    },
  ].filter((detail): detail is { label: string; value: string } => !!detail.value);

  return (
    <>
      <div className="flex flex-col">
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-1">
            <Text className="text-lg font-semibold">Style</Text>
            <Badge size="xs" radius="sm">
              {typeof meta.software === 'string' ? meta.software : 'Civitai Generator'}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            {style && (
              <CopyButton value={style}>
                {({ copy, copied, Icon, color }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy style'}>
                    <LegacyActionIcon onClick={copy} color={color}>
                      <Icon size={16} />
                    </LegacyActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            )}
            <Tooltip label={copiedAll ? 'Copied' : 'Copy all metadata'}>
              <LegacyActionIcon onClick={copyAll} color={copiedAll ? 'teal' : undefined}>
                {copiedAll ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </LegacyActionIcon>
            </Tooltip>
          </div>
        </div>
        {style ? (
          <LineClamp c="dimmed" className="text-sm">
            {style}
          </LineClamp>
        ) : (
          <Text c="dimmed" className="text-sm">
            No style prompt
          </Text>
        )}
      </div>
      {!!details.length && (
        <>
          <Divider />
          <dl className="m-0 flex flex-col gap-1 text-sm">
            {details.map(({ label, value }) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-dimmed">{label}</dt>
                <dd className="m-0 text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </>
  );
}
