import type { GroupProps } from '@mantine/core';
import {
  IconBrush,
  IconCurrencyDollar,
  IconGitMerge,
  IconUser,
} from '@tabler/icons-react';
import React from 'react';
import {
  PermissionIndicatorBase,
  type PermissionBadge,
} from '~/components/PermissionIndicator/PermissionIndicatorBase';

/**
 * Permission badge strip for Model3D licenses. Mirrors the visual of
 * `PermissionIndicator` (Models) — same colored, tooltipped icon row +
 * popover summary via `PermissionIndicatorBase` — but maps the
 * Model3DLicense boolean fields (commercial use, derivatives,
 * redistribution, attribution) instead of the Model permission set.
 *
 * Drop this in any 3D model surface that needs to display "what this
 * license allows": detail page footer, edit-page license picker,
 * potentially feed cards. Inline duplication of the icon row should be
 * replaced with this component.
 */
type Model3DLicensePermissions = {
  allowCommercialUse: boolean;
  allowDerivatives: boolean;
  allowRedistribution: boolean;
  requireAttribution: boolean;
};

export const Model3DPermissionIndicator = ({
  license,
  size = 24,
  gap = 4,
  showNone = false,
  ...props
}: Props) => {
  const { allowCommercialUse, allowDerivatives, allowRedistribution, requireAttribution } = license;

  // Popover list — verbatim "users may…" phrasing, matching the Model
  // PermissionIndicator dropdown tone. The leading `!requireAttribution`
  // flip lets us express attribution as a permission (i.e. "use without
  // crediting the creator") instead of an obligation.
  const explanation = {
    'Use this 3D model commercially': allowCommercialUse,
    'Create and share derivatives': allowDerivatives,
    'Redistribute this 3D model': allowRedistribution,
    'Use without crediting the creator': !requireAttribution,
  };

  const iconSize = Math.round(size / 2);
  const badges: PermissionBadge[] = [
    {
      label: allowCommercialUse ? 'Commercial use allowed' : 'No commercial use',
      icon: <IconCurrencyDollar size={iconSize} stroke={1.5} />,
      allowed: allowCommercialUse,
    },
    {
      label: allowDerivatives ? 'Derivatives allowed' : 'No derivatives',
      icon: <IconGitMerge size={iconSize} stroke={1.5} />,
      allowed: allowDerivatives,
    },
    {
      label: allowRedistribution ? 'Redistribution allowed' : 'No redistribution',
      icon: <IconBrush size={iconSize} stroke={1.5} />,
      allowed: allowRedistribution,
    },
    {
      label: requireAttribution ? 'Attribution required' : 'No attribution required',
      icon: <IconUser size={iconSize} stroke={1.5} />,
      allowed: !requireAttribution,
    },
  ];

  return (
    <PermissionIndicatorBase
      badges={badges}
      explanation={explanation}
      popoverTitle="This 3D model permits users to:"
      size={size}
      gap={gap}
      showNone={showNone}
      {...props}
    />
  );
};

type Props = {
  license: Model3DLicensePermissions;
  size?: number;
  showNone?: boolean;
} & Omit<GroupProps, 'size'>;
