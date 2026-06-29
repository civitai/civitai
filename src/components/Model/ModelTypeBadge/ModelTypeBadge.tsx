import type { BadgeProps } from '@mantine/core';
import { Badge, Divider, Popover, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { IconHorse } from '@tabler/icons-react';
import { IconNose } from '~/components/SVG/IconNose';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { getDisplayName } from '~/utils/string-helpers';

const BaseModelIndicator: Partial<Record<BaseModel, React.ReactNode | string>> = {
  'SDXL 1.0': 'XL',
  'SDXL 0.9': 'XL',
  'SDXL Lightning': 'XL',
  'SDXL 1.0 LCM': 'XL',
  'SDXL Distilled': 'XL',
  'SDXL Turbo': 'XL',
  'SDXL Hyper': 'XL',
  Pony: <IconHorse size={16} strokeWidth={2.5} />,
  'Flux.1 D': 'F1',
  'Flux.1 S': 'F1',
  'Flux.2 D': 'F2',
  'SD 1.4': 'SD1',
  'SD 1.5': 'SD1',
  'SD 1.5 LCM': 'SD1',
  'SD 1.5 Hyper': 'SD1',
  'SD 2.0': 'SD2',
  'SD 2.0 768': 'SD2',
  'SD 2.1': 'SD2',
  'SD 2.1 768': 'SD2',
  'SD 2.1 Unclip': 'SD2',
  'SD 3': 'SD3',
  'SD 3.5': 'SD3',
  'SD 3.5 Medium': 'SD3',
  'SD 3.5 Large': 'SD3',
  'SD 3.5 Large Turbo': 'SD3',
  SVD: 'SVD',
  'SVD XT': 'SVD',
  'PixArt E': 'Σ',
  'PixArt a': 'α',
  'Hunyuan 1': 'HY',
  Lumina: 'L',
  ODOR: <IconNose size={16} strokeWidth={2} />,
  Illustrious: 'IL',
  NoobAI: 'NAI',
  HiDream: 'HID',
  Chroma: 'CHR',
  ZImageTurbo: 'ZIT',
  Qwen: 'QW',
};

export function ModelTypeBadge({ type, baseModel, baseModels, ...badgeProps }: Props) {
  const [opened, setOpened] = useState(false);
  const bases = baseModels?.length ? baseModels : [baseModel];

  // Dedup by short code (e.g. SD 1.4 + SD 1.5 -> one "SD1"), preserving order.
  const seen = new Set<string>();
  const codes: { base: BaseModel; node: React.ReactNode | string }[] = [];
  for (const base of bases) {
    const node = BaseModelIndicator[base];
    if (node == null) continue;
    const key = typeof node === 'string' ? node : base;
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push({ base, node });
  }

  const MAX = 3;
  const visible = codes.slice(0, MAX);
  const overflow = codes.length - visible.length;
  const isMulti = codes.length > 1;

  const indicators = (
    <span className="flex items-center gap-2">
      {visible.map(({ base, node }) =>
        typeof node === 'string' ? (
          <Text key={base} size="xs" inherit>
            {node}
          </Text>
        ) : (
          <span key={base} className="flex items-center">
            {node}
          </span>
        )
      )}
      {overflow > 0 && (
        <Text size="xs" fw={700} inherit>
          +{overflow}
        </Text>
      )}
    </span>
  );

  return (
    <Badge
      variant="light"
      radius="xl"
      {...badgeProps}
      classNames={{ label: 'flex items-center gap-2' }}
    >
      <Text size="xs" tt="capitalize" fw="bold">
        {getDisplayName(type)}
      </Text>

      {visible.length > 0 && (
        <>
          <Divider className="border-l-white/30 border-r-black/20" orientation="vertical" />
          {isMulti ? (
            <Popover
              opened={opened}
              onChange={setOpened}
              withinPortal
              withArrow
              position="bottom-start"
              shadow="md"
            >
              <Popover.Target>
                <span
                  className="flex cursor-pointer items-center gap-2"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpened((o) => !o);
                  }}
                >
                  {indicators}
                </span>
              </Popover.Target>
              <Popover.Dropdown
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <Stack gap={2}>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    Base models
                  </Text>
                  {bases.map((base) => (
                    <Text key={base} size="sm">
                      {base}
                    </Text>
                  ))}
                </Stack>
              </Popover.Dropdown>
            </Popover>
          ) : (
            indicators
          )}
        </>
      )}
    </Badge>
  );
}

type Props = Omit<BadgeProps, 'children'> & {
  type: ModelType;
  baseModel: BaseModel;
  baseModels?: BaseModel[];
};
