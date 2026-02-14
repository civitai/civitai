/**
 * WhatIfAlert
 *
 * Displays error messages from whatIf cost calculation queries.
 */

import { Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';

interface WhatIfAlertProps {
  error?: { message?: string } | null;
}

export function WhatIfAlert({ error }: WhatIfAlertProps) {
  if (!error) return null;

  return (
    <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
      {error.message || 'Failed to calculate cost'}
    </Alert>
  );
}
