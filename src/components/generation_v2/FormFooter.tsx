/**
 * FormFooter
 *
 * Footer component for the generation form with quantity input,
 * submit button, and reset button.
 */

import { Button, Card, NumberInput, Text } from '@mantine/core';
import { useState } from 'react';

import { Controller, useGraph } from '~/libs/data-graph/react';
import { type GenerationGraphTypes } from '~/shared/data-graph/generation';

export function FormFooter() {
  const graph = useGraph<GenerationGraphTypes>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    console.log({ snapshot: graph.getSnapshot() });
    const result = graph.validate();

    if (!result.success) {
      console.log('Validation failed:', result.errors);
      return;
    }

    setIsSubmitting(true);
    try {
      const inputData = Object.fromEntries(
        Object.entries(result.data).filter(([k]) => result.nodes[k]?.kind !== 'computed')
      );
      console.log('Submitting:', inputData);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    // Don't exclude 'model' - it should be reset to match the baseModel
    // The checkpointNode factory will select a default model for the baseModel
    graph.reset({ exclude: ['workflow', 'baseModel'] });
  };

  return (
    <div className="shadow-topper sticky bottom-0 z-10 flex gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
      <Controller
        graph={graph}
        name="quantity"
        render={({ value, meta, onChange }) => (
          <Card withBorder className="flex max-w-[88px] flex-col p-0">
            <Text className="pr-6 text-center text-xs font-semibold" c="dimmed">
              Quantity
            </Text>
            <NumberInput
              value={value ?? 1}
              onChange={(val) => onChange(Number(val) || 1)}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              size="md"
              variant="unstyled"
              styles={{
                input: {
                  textAlign: 'center',
                  fontWeight: 700,
                  fontSize: 20,
                  padding: 0,
                },
              }}
            />
          </Card>
        )}
      />
      <Button className="h-auto flex-1" onClick={handleSubmit} loading={isSubmitting}>
        Submit
      </Button>
      <Button onClick={handleReset} variant="default" className="h-auto px-3">
        Reset
      </Button>
    </div>
  );
}
