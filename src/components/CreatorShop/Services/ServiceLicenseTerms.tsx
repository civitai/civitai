import { Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ServiceLicense } from '~/shared/constants/creator-service-license.constants';
import {
  SERVICE_LICENSE_COPYRIGHT_LINE,
  SERVICE_LICENSE_PARTY_LINE,
  SERVICE_LICENSE_PRESET_LABELS,
  SERVICE_LICENSE_PRESET_TERMS,
  SERVICE_LICENSE_RESALE_LABEL,
  serviceLicenseHasResaleToggle,
} from '~/shared/constants/creator-service-license.constants';

/** The seller's license as a buyer reads it: on the listing, in the request dialog and on the deal. */
export function ServiceLicenseTerms({
  license,
  children,
}: {
  license: ServiceLicense & { licensePreset: NonNullable<ServiceLicense['licensePreset']> };
  /** Below the terms: the agree checkbox, or when it was agreed. */
  children?: ReactNode;
}) {
  const preset = license.licensePreset;
  const terms = SERVICE_LICENSE_PRESET_TERMS[preset] ?? license.licenseCustomText;
  const ResaleIcon = license.licenseAllowResale ? IconCheck : IconX;
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="xs">
        <Text fw={600}>License: {SERVICE_LICENSE_PRESET_LABELS[preset]}</Text>
        <Text size="sm" className="whitespace-pre-line break-words">
          {terms}
        </Text>
        {serviceLicenseHasResaleToggle(preset) && (
          <Group gap={6} wrap="nowrap">
            <ResaleIcon size={16} aria-hidden />
            <Text size="sm">
              {SERVICE_LICENSE_RESALE_LABEL}
              <span className="sr-only">: {license.licenseAllowResale ? 'yes' : 'no'}</span>
            </Text>
          </Group>
        )}
        <Text size="sm">{SERVICE_LICENSE_COPYRIGHT_LINE}</Text>
        <Text size="xs" c="dimmed">
          {SERVICE_LICENSE_PARTY_LINE}
        </Text>
        {children}
      </Stack>
    </Paper>
  );
}

/** Narrows an offering or deal to one with license terms. */
export const hasServiceLicense = <T extends ServiceLicense>(
  value: T
): value is T & { licensePreset: NonNullable<ServiceLicense['licensePreset']> } =>
  value.licensePreset != null;
