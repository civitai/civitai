import { TypographyStylesProvider } from '@mantine/core';
import React from 'react';

export function RenderHtml({ html }: Props) {
  return (
    <TypographyStylesProvider>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesProvider>
  );
}

type Props = { html: string };
