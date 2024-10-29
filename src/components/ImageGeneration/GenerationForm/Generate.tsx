import { Accordion, Button, SegmentedControl, Select, Text } from '@mantine/core';
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
import { WorkflowConfigInput } from '~/components/Generation/Input/WorkflowConfigInput';
import { GenerationWorkflowConfig } from '~/shared/types/generation.types';
import { workflows } from '~/components/Generation/config';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';

// const availableWorkflows = workflows;

/**
  TODO list
  - if there are multiple workflows available for a model/env/category, then use the user's last selected workflow, otherwise default to first workflow available
 */

export function Generate() {
  const [tab, setTab] = useState('image');
  const [config, setConfig] = useState<GenerationWorkflowConfig>(
    workflows.filter(
      (x) => x.type === 'image' && x.subType === 'txt2img' && x.name === 'Standard'
    )[0]
  ); // TODO - see todo list
  const isClient = useIsClient();

  const form = useForm({ defaultValues: { ...config.values } });

  if (!isClient) return null;

  function handleSubmit(data: Record<string, unknown>) {
    console.log(data);
  }

  return (
    <GenerationProvider>
      <Form form={form} className="flex flex-1 flex-col" onSubmit={handleSubmit}>
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
          {config.fields.map((field, i) => (
            <WorkflowConfigInput key={'name' in field ? field.name : i} {...field} />
          ))}
          <PersistentAccordion storeKey="generation-form-advanced" variant="contained">
            <Accordion.Item value="advanced">
              <Accordion.Control>
                <Text size="sm" weight={590}>
                  Advanced
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <div className="flex flex-col gap-3">
                  {config.advanced?.map((field, i) => (
                    <WorkflowConfigInput key={'name' in field ? field.name : i} {...field} />
                  ))}
                </div>
              </Accordion.Panel>
            </Accordion.Item>
          </PersistentAccordion>
        </ScrollArea>
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

// const workflowConfig = {
//   workflow: 'txt2img',
//   schema: z.object({}),
//   fields: <></>,
// };
