import type { MantineTheme } from '@mantine/core';
import type { CSSProperties } from 'react';

/** The tinted band under a creator card's main section: its links row and, when given, its footer. */
export function creatorCardSectionStyle(
  theme: MantineTheme,
  colorScheme: 'light' | 'dark'
): CSSProperties {
  return { background: colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0] };
}
