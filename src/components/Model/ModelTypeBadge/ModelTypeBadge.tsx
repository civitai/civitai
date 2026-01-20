import type { BadgeProps } from '@mantine/core';
import { Badge, Divider, Text } from '@mantine/core';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { IconHorse } from '@tabler/icons-react';
import { IconNose } from '~/components/SVG/IconNose';
import type { BaseModel } from '~/shared/constants/base-model.constants';
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

export function ModelTypeBadge({ type, baseModel, ...badgeProps }: Props) {
  const baseModelIndicator = BaseModelIndicator[baseModel];
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

      {baseModelIndicator && (
        <>
          <Divider className="border-l-white/30 border-r-black/20" orientation="vertical" />
          {typeof baseModelIndicator === 'string' ? (
            <Text size="xs" inherit>
              {baseModelIndicator}
            </Text>
          ) : (
            baseModelIndicator
          )}
        </>
      )}
    </Badge>
  );
}

type Props = Omit<BadgeProps, 'children'> & { type: ModelType; baseModel: BaseModel };
