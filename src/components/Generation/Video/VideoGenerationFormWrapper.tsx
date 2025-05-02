import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import {
  videoGenerationConfig2,
  OrchestratorEngine2,
} from '~/server/orchestrator/generation/generation.config';
import { useMemo, useState, useEffect } from 'react';
import { hashify } from '~/utils/string-helpers';
import { z } from 'zod';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { Form } from '~/libs/form';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { useIsMutating } from '@tanstack/react-query';
import { Button, Notification, Alert, Anchor, Input, Loader, Select, Text } from '@mantine/core';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useFormContext, UseFormReturn } from 'react-hook-form';
import { getQueryKey } from '@trpc/react-query';
import { trpc } from '~/utils/trpc';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { IconX } from '@tabler/icons-react';
import {
  useVideoGenerationStore,
  useGenerationEngines,
} from '~/components/Generation/Video/VideoGenerationProvider';

export function VideoGenerationFormWrapper({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useGenerationEngines();
  const setState = useVideoGenerationStore((state) => state.setState);
  const engine = useVideoGenerationStore((state) => state.engine);
  const selected = data.find((x) => x.engine === engine);

  const status = useGenerationStatus();

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-2 px-3">
        <Alert>
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
            Note: this is an experimental build. Pricing, default settings, and results are subject
            to change.
          </Text>
        </Alert>
        {isLoading ? (
          <div className="flex items-center justify-center p-3">
            <Loader />
          </div>
        ) : selected?.disabled ? (
          <Alert
            color="yellow"
            className="mx-3"
            title={<span className="capitalize">{`${selected?.engine} generation disabled`}</span>}
          >
            {selected?.message && <Text className="mb-2">{selected?.message}</Text>}
            <Text className="mb-1">Try out another video generation tool:</Text>
            <div className="flex flex-wrap gap-2">
              {uniqBy(
                data.filter((x) => !x.disabled),
                'engine'
              ).map(({ engine }) => (
                <Button
                  key={engine}
                  compact
                  onClick={() => setState({ engine })}
                  variant="outline"
                  color="yellow"
                  className="capitalize"
                >
                  {getDisplayName(engine)}
                </Button>
              ))}
            </div>
          </Alert>
        ) : (
          <Select
            label="Tool"
            value={selected}
            description={selected?.message && !selected?.disabled ? selected.message : undefined}
            onChange={(engine) => setState({ engine: engine as OrchestratorEngine2 })}
            data={data?.map(({ key, label }) => ({ label, value: key }))}
          />
        )}
      </div>
    </div>
  );
}
