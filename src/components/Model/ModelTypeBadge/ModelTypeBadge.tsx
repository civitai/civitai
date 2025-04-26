import { Badge, BadgeProps, Divider, Text } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import { IconHorse } from '@tabler/icons-react';
import { IconNose } from '~/components/SVG/IconNose';
import { BaseModel } from '~/server/common/constants';
import { getDisplayName } from '~/utils/string-helpers';
import styles from './ModelTypeBadge.module.scss';

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
};

export function ModelTypeBadge({ type, baseModel, ...badgeProps }: Props) {
  const baseModelIndicator = BaseModelIndicator[baseModel];
  const typeClass = styles[`type${type}`];

  return (
    <Badge className={`${styles.badge} ${typeClass}`} {...badgeProps}>
      <Text className={styles.typeText}>{getDisplayName(type)}</Text>

      {baseModelIndicator && (
        <>
          <Divider className={styles.divider} orientation="vertical" />
          {typeof baseModelIndicator === 'string' ? (
            <Text className={styles.baseModelIndicator}>{baseModelIndicator}</Text>
          ) : (
            <span className={styles.baseModelIndicator}>{baseModelIndicator}</span>
          )}
        </>
      )}
    </Badge>
  );
}

type Props = Omit<BadgeProps, 'children'> & { type: ModelType; baseModel: BaseModel };

