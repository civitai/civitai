import { Divider, Text, ActionIcon } from '@mantine/core';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';

type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  clipSkip: 'Clip skip',
} as const;

export function ImageMeta({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const meta = data?.meta;

  if (!meta) return null;

  const simpleMeta = Object.entries(simpleMetaProps).filter(
    ([key]) => meta[key as keyof typeof meta]
  );
  const hasSimpleMeta = !!simpleMeta.length;

  return (
    <>
      {meta.prompt && (
        <div className="flex flex-col">
          <div className="flex justify-between items-center">
            <Text className="text-lg font-semibold">Prompt</Text>
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
          <div className="flex justify-between items-center">
            <Text className="text-md font-semibold">Negative prompt</Text>
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
            <div className="flex justify-between items-center">
              <Text className="text-md font-semibold">Other metadata</Text>
            </div>
            <div className="flex flex-col">
              {simpleMeta.map(([key, label]) => (
                <div key={key} className="flex justify-between gap-3">
                  <Text color="dimmed" className="leading-snug text-nowrap">
                    {label}
                  </Text>
                  <Text className="leading-snug">{meta[key as SimpleMetaPropsKey]}</Text>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
