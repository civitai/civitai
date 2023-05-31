import {
  AspectRatio,
  Box,
  Card,
  Center,
  Group,
  Input,
  Paper,
  SegmentedControl,
  Stack,
  Textarea,
  createStyles,
  Text,
  Accordion,
  Divider,
  Grid,
  NumberInput,
} from '@mantine/core';
import { IconBook2 } from '@tabler/icons-react';
import { ClearableNumberInput } from '~/components/ClearableNumberInput/ClearableNumberInput';

export function Generate() {
  return (
    <form>
      <Stack>
        <Input.Wrapper label="Model">
          <div></div>
          {/* TODO.Resource selection */}
        </Input.Wrapper>
        <Input.Wrapper
          labelProps={{ sx: { width: '100%' } }}
          label={
            <Group position="apart">
              Prompt
              <Text variant="link">
                <Group align="center" spacing={4}>
                  <span>From Collection</span> <IconBook2 size={16} />
                </Group>
              </Text>
            </Group>
          }
        >
          <Textarea />
          {/* TODO.prompt */}
        </Input.Wrapper>
        <Stack spacing={0}>
          <Input.Label>Aspect Ratio</Input.Label>
          <SegmentedControl data={aspectRatioControls} />
        </Stack>

        {/* ADVANCED */}
        <Accordion variant="separated">
          <Accordion.Item value="advanced">
            <Accordion.Control>
              <Divider label="Advanced" labelPosition="left" labelProps={{ size: 'md' }} />
            </Accordion.Control>
            <Accordion.Panel>
              <Stack>
                <Stack spacing={0}>
                  <Input.Label>Creativity (CFG Scale)</Input.Label>
                  <SegmentedControl data={cfgScales} />
                </Stack>
                <Stack spacing={0}>
                  <Input.Label>Engine (Sampler)</Input.Label>
                  <SegmentedControl data={samplers} />
                </Stack>
                <Stack spacing={0}>
                  <Input.Label>Quality (Steps)</Input.Label>
                  <SegmentedControl data={steps} />
                </Stack>
                <Grid>
                  <Grid.Col span={6}>
                    <ClearableNumberInput label="Seed" placeholder="Random" min={0} clearable />
                  </Grid.Col>
                  <Grid.Col span={6}>
                    <NumberInput label="Clip Skip" min={0} />
                  </Grid.Col>
                </Grid>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        {/* TODO.Quantity,Go */}
      </Stack>
    </form>
  );
}

const aspectRatioDetails = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];
const aspectRatioControls = aspectRatioDetails.map(({ label, width, height }) => ({
  label: (
    <Stack spacing={4} py="xs">
      <Center>
        <Paper withBorder sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 30 }} />
      </Center>
      {label}
    </Stack>
  ),
  value: `${width}x${height}`,
}));

const cfgScales = [
  { label: 'Creative', value: '4' },
  { label: 'Balanced', value: '7' },
  { label: 'Precise', value: '10' },
];

const samplers = [
  { label: 'Fast', value: 'Euler A' },
  { label: 'Popular', value: 'DPM++ 2M Karras' },
  { label: 'Quality', value: 'DPM++ SDE Karras' },
];

const steps = [
  { label: 'Fast', value: '10' },
  { label: 'Balanced', value: '20' },
  { label: 'High', value: '30' },
];
