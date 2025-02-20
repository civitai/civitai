import { Alert } from '@mantine/core';

export function WhatIfAlert({ error }: { error?: any }) {
  if (!error) return null;

  const message =
    typeof error.message === 'string' && error.message.trim().length > 0
      ? error.message
      : 'Error calculating cost. Please try updating your values';

  return <Alert color="yellow">{message}</Alert>;
}
