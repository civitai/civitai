import { TypographyStylesProvider, TypographyStylesProviderProps } from '@mantine/core';
import React from 'react';

export function RenderHtml({ html, ...props }: Props) {
  return (
    <TypographyStylesProvider {...props}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesProvider>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & { html: string };
