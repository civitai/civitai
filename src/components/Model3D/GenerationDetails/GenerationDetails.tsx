import { Badge, Box, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconWand } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';

/**
 * GenerationDetails
 *
 * Renders the provider-agnostic 3D generation params from `Model3D.generationParams`.
 * Surfaces (per plan §2.14 / §6.26): prompt, topology, polycount, symmetryMode,
 * enablePbr, mode (preview/full), seed, enableRigging, enableAnimation, texturePrompt.
 * For image-to-3D, renders the source image preview.
 *
 * Provider-specific params (e.g. `enablePromptExpansion`) are intentionally hidden.
 */

type SourceImage = {
  id: number;
  url: string;
  name?: string | null;
  type?: string | null;
  width?: number | null;
  height?: number | null;
} | null;

type GenerationDetailsProps = {
  params: unknown;
  sourceImage?: SourceImage;
};

// Provider-agnostic params we surface in the UI.
const SURFACED_KEYS = [
  'prompt',
  'topology',
  'targetPolycount',
  'symmetryMode',
  'enablePbr',
  'mode',
  'seed',
  'enableRigging',
  'enableAnimation',
  'texturePrompt',
] as const;

type SurfacedKey = (typeof SURFACED_KEYS)[number];

const LABELS: Record<SurfacedKey, string> = {
  prompt: 'Prompt',
  topology: 'Topology',
  targetPolycount: 'Target polycount',
  symmetryMode: 'Symmetry',
  enablePbr: 'PBR materials',
  mode: 'Mode',
  seed: 'Seed',
  enableRigging: 'Rigging',
  enableAnimation: 'Animation',
  texturePrompt: 'Texture prompt',
};

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function readParams(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  return input as Record<string, unknown>;
}

export function GenerationDetails({ params, sourceImage }: GenerationDetailsProps) {
  const obj = readParams(params);
  if (!obj && !sourceImage) return null;

  const rows: Array<{ key: SurfacedKey; value: unknown }> = [];
  if (obj) {
    for (const key of SURFACED_KEYS) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        rows.push({ key, value: obj[key] });
      }
    }
  }

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group gap="xs">
          <IconWand size={20} />
          <Title order={3}>Generation Details</Title>
        </Group>

        {sourceImage && (
          <Box>
            <Text size="sm" fw={500} mb={4}>
              Source image
            </Text>
            <Link
              href={`/images/${sourceImage.id}`}
              className="block w-full max-w-[240px] overflow-hidden rounded-md border border-solid border-dark-4"
            >
              <EdgeMedia
                src={sourceImage.url}
                name={sourceImage.name ?? undefined}
                type={(sourceImage.type as 'image' | 'video' | 'audio' | undefined) ?? undefined}
                width={320}
                anim={false}
                className="size-full object-cover"
              />
            </Link>
          </Box>
        )}

        {rows.length > 0 ? (
          <Stack gap={6}>
            {rows.map(({ key, value }) => {
              const isPrompt = key === 'prompt' || key === 'texturePrompt';
              return (
                <Group key={key} align="flex-start" wrap="nowrap" gap="sm">
                  <Text size="sm" c="dimmed" miw={140}>
                    {LABELS[key]}
                  </Text>
                  {isPrompt ? (
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {formatValue(value)}
                    </Text>
                  ) : (
                    <Badge variant="light" size="md" radius="sm">
                      {formatValue(value)}
                    </Badge>
                  )}
                </Group>
              );
            })}
          </Stack>
        ) : (
          <Text c="dimmed" size="sm">
            No generation details available.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

export default GenerationDetails;
