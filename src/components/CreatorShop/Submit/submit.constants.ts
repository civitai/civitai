import { CosmeticType } from '~/shared/utils/prisma/enums';

export const cosmeticTypeOptions = [
  { value: CosmeticType.Badge, label: 'Badge' },
  { value: CosmeticType.ProfileDecoration, label: 'Avatar Frame' },
  { value: CosmeticType.ProfileBackground, label: 'Profile Background' },
];
