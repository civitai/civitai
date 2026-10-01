import { Accordion, Group, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { EligibleModelsList } from '~/components/EligibleModels/EligibleModelsList';

// Mock model data representing what the API returns
const mockModels = [
  {
    id: 1,
    name: 'Pony Diffusion V6 XL',
    versionId: 101,
    versionName: 'V6 XL',
    baseModel: 'Pony',
    image: null,
  },
  {
    id: 2,
    name: 'Illustrious XL',
    versionId: 102,
    versionName: 'v0.1',
    baseModel: 'Illustrious',
    image: null,
  },
  {
    id: 3,
    name: 'Realistic Vision',
    versionId: 103,
    versionName: 'V6.0 B1',
    baseModel: 'SDXL 1.0',
    image: null,
  },
  {
    id: 4,
    name: 'Flux-Realism',
    versionId: 104,
    versionName: 'v1.0',
    baseModel: 'Flux.1 D',
    image: null,
  },
  {
    id: 5,
    name: 'NoobAI-XL',
    versionId: 105,
    versionName: 'v-pred 1.0',
    baseModel: 'NoobAI',
    image: null,
  },
  {
    id: 6,
    name: 'DreamShaper XL',
    versionId: 106,
    versionName: 'v2.1 Turbo',
    baseModel: 'SDXL 1.0',
    image: null,
  },
];

function EligibleModelsAccordion({ models }: { models: typeof mockModels }) {
  const colorScheme = useComputedColorScheme('dark');
  const theme = useMantineTheme();

  return (
    <div style={{ width: 320 }}>
      <Accordion
        variant="separated"
        multiple
        defaultValue={['models']}
        styles={() => ({
          content: { padding: 0 },
          item: {
            overflow: 'hidden',
            borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
            boxShadow: theme.shadows.sm,
          },
          control: {
            padding: theme.spacing.sm,
          },
        })}
      >
        <Accordion.Item value="models">
          <Accordion.Control>
            <Group justify="space-between">Eligible Models</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <EligibleModelsList models={models} onGenerate={() => undefined} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </div>
  );
}

/** Default view with all mock models */
export const Default = () => <EligibleModelsAccordion models={mockModels} />;

/** Single model */
export const SingleModel = () => <EligibleModelsAccordion models={[mockModels[0]]} />;

/** Long list to test scroll */
export const LongList = () => (
  <EligibleModelsAccordion
    models={[
      ...mockModels,
      ...mockModels.map((m, i) => ({
        ...m,
        versionId: m.versionId + 200 + i,
        name: `${m.name} (Copy)`,
      })),
    ]}
  />
);
