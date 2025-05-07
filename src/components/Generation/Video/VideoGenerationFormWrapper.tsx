import { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { Button, Alert, Loader, Select, Text } from '@mantine/core';
import {
  useVideoGenerationStore,
  useGenerationEngines,
  useSelectedVideoGenerationEngine,
} from '~/components/Generation/Video/VideoGenerationProvider';
import { uniqBy } from 'lodash-es';
import { VideoGenerationForm } from '~/components/Generation/Video/VideoGenerationForm';
import { generationFormStore } from '~/store/generation.store';

export function VideoGenerationFormWrapper() {
  const { data, isLoading } = useGenerationEngines();
  // const setState = useVideoGenerationStore((state) => state.setState);
  // const engine = useVideoGenerationStore((state) => state.engine);
  const setEngine = generationFormStore.setEngine;
  const engine = useSelectedVideoGenerationEngine();
  const selected = data.find((x) => x.engine === engine) ?? data[0];

  return (
    <div className="flex flex-1 flex-col gap-2">
      <Alert radius={0}>
        <Text>
          Learn more about{' '}
          <Text
            component="a"
            variant="link"
            href="https://education.civitai.com/civitais-guide-to-video-in-the-civitai-generator"
            target="blank"
            inline
          >
            video generation
          </Text>
        </Text>
        <Text size="xs" color="dimmed">
          Note: this is an experimental build. Pricing, default settings, and results are subject to
          change.
        </Text>
      </Alert>
      {isLoading ? (
        <div className="flex items-center justify-center p-3">
          <Loader />
        </div>
      ) : selected?.disabled ? (
        <Alert
          color="yellow"
          className="mx-2"
          title={<span className="capitalize">{`${selected?.engine} generation disabled`}</span>}
        >
          {selected?.message && <Text className="mb-2">{selected?.message}</Text>}
          <Text className="mb-1">Try out another video generation tool:</Text>
          <div className="flex flex-wrap gap-2">
            {uniqBy(
              data.filter((x) => !x.disabled),
              'engine'
            ).map(({ engine, label }) => (
              <Button
                key={engine}
                compact
                onClick={() => setEngine(engine)}
                variant="outline"
                color="yellow"
                className="capitalize"
              >
                {label}
              </Button>
            ))}
          </div>
        </Alert>
      ) : (
        <>
          <Select
            className="mx-2"
            label="Tool"
            value={engine}
            description={selected?.message && !selected?.disabled ? selected.message : undefined}
            onChange={(engine) => setEngine(engine)}
            data={data?.map(({ engine, label }) => ({ label, value: engine }))}
          />
          {engine && <VideoGenerationForm key={engine} />}
        </>
      )}
    </div>
  );
}
