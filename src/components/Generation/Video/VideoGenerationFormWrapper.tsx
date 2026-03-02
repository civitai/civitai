import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { Button, Alert, Loader, Select, Text, Anchor } from '@mantine/core';
import {
  useGenerationEngines,
  useSelectedVideoGenerationEngine,
} from '~/components/Generation/Video/VideoGenerationProvider';
import { uniqBy } from 'lodash-es';
import { VideoGenerationForm } from '~/components/Generation/Video/VideoGenerationForm';
import { generationFormStore } from '~/store/generation-form.store';

export function VideoGenerationFormWrapper() {
  const { data, isLoading } = useGenerationEngines();
  const setEngine = generationFormStore.setEngine;
  const engine = useSelectedVideoGenerationEngine();
  const selected = data.find((x) => x.engine === engine) ?? data[0];

  return (
    <div className="flex flex-1 flex-col gap-2">
      <Alert radius={0}>
        <Text>
          Learn more about{' '}
          <Anchor
            href="https://education.civitai.com/civitais-guide-to-video-in-the-civitai-generator"
            rel="nofollow noreferrer"
            target="_blank"
            inline
          >
            video generation
          </Anchor>
        </Text>
        <Text size="xs" c="dimmed">
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
                size="compact-sm"
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
            className="mx-2 mb-3"
            label="Tool"
            value={engine}
            description={selected?.message && !selected?.disabled ? selected.message : undefined}
            onChange={(engine) => setEngine(engine as OrchestratorEngine2)}
            data={data?.map(({ engine, label }) => ({ label, value: engine }))}
          />

          {engine && <VideoGenerationForm key={engine} engine={engine} />}
        </>
      )}
    </div>
  );
}
