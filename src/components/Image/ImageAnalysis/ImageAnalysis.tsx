import { ImageAnalysisInput } from '~/server/schema/image.schema';
import {
  Stack,
  Text,
  Code,
  Popover,
  PopoverProps,
  Group,
  SimpleGrid,
  Divider,
} from '@mantine/core';
import { capitalize } from 'lodash';
import React from 'react';

export function ImageAnalysis({
  analysis: { faces, ...nsfwScan },
}: {
  analysis: ImageAnalysisInput;
}) {
  const nsfwScore = (nsfwScan.porn + nsfwScan.hentai + nsfwScan.sexy / 2) * 100;
  return (
    <Stack spacing="xs">
      {faces?.map((face, i) => {
        return (
          <React.Fragment key={i}>
            <Divider label={`Face ${i + 1}`} />
            <SimpleGrid cols={2} verticalSpacing="xs">
              <Group spacing="xs">
                <Text size="sm" mr="xs" weight={500}>
                  Age
                </Text>
                <Code
                  sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}
                  color={face.age < 18 ? 'red' : undefined}
                >
                  {face.age.toFixed(2)}
                </Code>
              </Group>
              <Group spacing="xs">
                <Text size="sm" mr="xs" weight={500}>
                  Gender
                </Text>
                <Code
                  sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}
                  color={face.genderConfidence > 0.8 ? 'teal' : undefined}
                >
                  {face.gender}
                </Code>
              </Group>
            </SimpleGrid>
          </React.Fragment>
        );
      })}
      <Divider label="NSFW Asessment" />
      <SimpleGrid cols={2} verticalSpacing="xs">
        <Group spacing="xs">
          <Text size="sm" mr="xs" weight={500}>
            NSFW
          </Text>
          <Code
            sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}
            color={nsfwScore > 60 ? 'red' : undefined}
          >
            {nsfwScore.toFixed(2)}
          </Code>
        </Group>
        {Object.entries(nsfwScan)
          .sort(([, v1], [, v2]) => v2 - v1)
          .map(([label, value]) => (
            <Group key={label} spacing="xs">
              <Text size="sm" mr="xs" weight={500}>
                {capitalize(label)}
              </Text>
              <Code
                sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}
              >
                {(value * 100).toFixed(2)}
              </Code>
            </Group>
          ))}
      </SimpleGrid>
    </Stack>
  );
}

export function ImageAnalysisPopover({
  analysis,
  children,
  ...popoverProps
}: { analysis?: ImageAnalysisInput; children: React.ReactElement } & PopoverProps) {
  if (!analysis) return null;
  return (
    <Popover width={350} shadow="md" position="top-start" withArrow withinPortal {...popoverProps}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <ImageAnalysis analysis={analysis} />
      </Popover.Dropdown>
    </Popover>
  );
}
