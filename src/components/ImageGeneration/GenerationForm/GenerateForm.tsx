import { Card, Group, NumberInputProps, SliderProps, Stack, Text } from '@mantine/core';
import { UseFormReturn } from 'react-hook-form';
import { Form, InputNumberSlider, InputSwitch, InputTextArea } from '~/libs/form';
import { GenerateFormModel } from '~/server/schema/generation.schema';

const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

export function GenerateForm({ form }: { form: UseFormReturn<GenerateFormModel> }) {
  return (
    <Form form={form}>
      <Stack>
        <Card>
          <Stack>
            {/* TODO.resources */}
            <InputTextArea name="prompt" label="Prompt" withAsterisk />
            <InputTextArea name="negativePrompt" label="Negative Prompt" />
            <InputSwitch
              name="nsfw"
              label="Mature content"
              labelPosition="left"
              wrapperProps={{ style: { display: 'flex', justifyContent: 'space-between' } }}
            />
          </Stack>
        </Card>
        <Card>
          <Stack>
            <Text>TODO.aspect ratio </Text>
            <Text>TODO.advanced settings</Text>
            <Group position="apart">
              <InputNumberSlider
                name="steps"
                min={1}
                max={150}
                sliderProps={sharedSliderProps}
                numberProps={sharedNumberProps}
              />
              <InputNumberSlider
                name="cfgScale"
                min={1}
                max={30}
                step={0.5}
                precision={1}
                sliderProps={sharedSliderProps}
                numberProps={sharedNumberProps}
              />
            </Group>
          </Stack>
        </Card>
        <Card>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
        </Card>
      </Stack>
    </Form>
  );
}
