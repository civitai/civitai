import type { GroupProps } from '@mantine/core';
import {
  IconBrush,
  IconCurrencyDollar,
  IconGitMerge,
  IconLicense,
  IconRating18Plus,
  IconUser,
} from '@tabler/icons-react';
import React from 'react';
import {
  PermissionIndicatorBase,
  type PermissionBadge,
} from '~/components/PermissionIndicator/PermissionIndicatorBase';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CommercialUse } from '~/shared/utils/prisma/enums';

/**
 * Permission badge strip for AI Models. Surfaces the model's licensing
 * permissions (commercial use, generation services, credit, merges,
 * derivative licenses, NSFW) as a row of tooltipped colored icons with a
 * popover summary. Mod-only badges (NSFW) are filtered out for
 * non-moderators.
 *
 * The visual is shared with Model3DPermissionIndicator via
 * `PermissionIndicatorBase`; the two components diverge only in their
 * domain mapping (Model permissions vs. Model3D license fields).
 */
export const PermissionIndicator = ({
  permissions,
  size = 24,
  gap = 4,
  showNone = false,
  ...props
}: Props) => {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;

  const { allowNoCredit, allowCommercialUse, allowDerivatives, allowDifferentLicense, sfwOnly } =
    permissions;
  const canSellImages = allowCommercialUse.includes(CommercialUse.Image);
  const canRentCivit = allowCommercialUse.includes(CommercialUse.RentCivit);
  const canRent = allowCommercialUse.includes(CommercialUse.Rent);
  const canSell = allowCommercialUse.includes(CommercialUse.Sell);

  const explanation = {
    'Use the model without crediting the creator': allowNoCredit,
    'Sell images they generate': canSellImages,
    'Run on services that generate for money': canRent,
    'Run on Civitai': canRentCivit,
    'Share merges using this model': allowDerivatives,
    'Sell this model or merges using this model': canSell,
    'Have different permissions when sharing merges': allowDifferentLicense,
    ...(isModerator && { 'Create NSFW generations': !sfwOnly }),
  };

  const iconSize = Math.round(size / 2);
  const badges: PermissionBadge[] = [
    {
      label: canSellImages || canSell ? 'Commercial use allowed' : 'No commercial use',
      icon: <IconCurrencyDollar size={iconSize} stroke={1.5} />,
      allowed: canSellImages || canSell,
    },
    {
      label: canRentCivit || canRent ? 'Generation services allowed' : 'No generation services',
      icon: <IconBrush size={iconSize} stroke={1.5} />,
      allowed: canRentCivit || canRent,
    },
    {
      label: allowNoCredit ? 'No credit required' : 'Creator credit required',
      icon: <IconUser size={iconSize} stroke={1.5} />,
      allowed: allowNoCredit,
    },
    {
      label: allowDerivatives ? 'Merges allowed' : 'No merges allowed',
      icon: <IconGitMerge size={iconSize} stroke={1.5} />,
      allowed: allowDerivatives,
    },
    {
      label: allowDifferentLicense
        ? 'Different permissions allowed on merges'
        : 'Same permissions required on merges',
      icon: <IconLicense size={iconSize} stroke={1.5} />,
      allowed: allowDifferentLicense,
    },
    {
      label: sfwOnly ? 'No NSFW generation' : 'NSFW generation allowed',
      icon: <IconRating18Plus size={iconSize} stroke={1.5} />,
      allowed: !sfwOnly,
      visible: isModerator,
    },
  ];

  return (
    <PermissionIndicatorBase
      badges={badges}
      explanation={explanation}
      size={size}
      gap={gap}
      showNone={showNone}
      {...props}
    />
  );
};

type Props = {
  permissions: Permissions;
  size?: number;
  showNone?: boolean;
} & Omit<GroupProps, 'size'>;

type Permissions = {
  allowNoCredit: boolean;
  allowCommercialUse: CommercialUse[];
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  sfwOnly: boolean;
};
