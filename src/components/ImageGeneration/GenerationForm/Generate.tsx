import { Button, SegmentedControl, Select } from '@mantine/core';
import React, { useState } from 'react';
import { GenerationFormContent } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { TextToImageWhatIfProvider } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { useForm } from 'react-hook-form';
import { useIsClient } from '~/providers/IsClientProvider';
import { Form } from '~/libs/form';
import { z } from 'zod';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { QueueSnackbar2 } from '~/components/ImageGeneration/QueueSnackbar';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

export function Generate() {
  const [tab, setTab] = useState('image');
  const [workflow, setWorkflow] = useState('txt2img');
  const isClient = useIsClient();

  const form = useForm({});

  if (!isClient) return null;

  return (
    <GenerationProvider>
      <Form form={form} className="flex flex-1 flex-col">
        <ScrollArea
          scrollRestore={{ key: 'generation-form' }}
          pt={0}
          className="flex flex-col gap-2 px-3"
        >
          <SegmentedControl
            value={tab}
            onChange={setTab}
            data={[
              { label: 'Image', value: 'image' },
              { label: 'Video', value: 'video' },
            ]}
          />
          <Select label="Workflow" data={['test']} />
        </ScrollArea>
        {/* <GenerationFormProvider>
          <TextToImageWhatIfProvider>
            <GenerationFormContent />
          </TextToImageWhatIfProvider>
        </GenerationFormProvider> */}
        <div className="shadow-topper flex flex-col gap-2 rounded-xl p-2">
          <QueueSnackbar2 />
          <div className="flex gap-2">
            <Button type="submit" className="flex-1 px-3">
              Generate
            </Button>
            <Button variant="default" className="px-3">
              Reset
            </Button>
          </div>
        </div>
      </Form>
    </GenerationProvider>
  );
}

const workflowConfig = {
  workflow: 'txt2img',
  schema: z.object({}),
  fields: <></>,
};
