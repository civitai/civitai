import { Divider, Text } from '@mantine/core';
import { LineClamp } from '~/components/LineClamp/LineClamp';
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
              <Text className="text-lg font-semibold">Other metadata</Text>
            </div>
            <div className="flex flex-col">
              {simpleMeta.map(([key, label]) => (
                <div key={key} className="flex justify-between">
                  <Text color="dimmed" className="leading-snug">
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
