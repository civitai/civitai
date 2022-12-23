import {
  createStyles,
  TypographyStylesProvider,
  TypographyStylesProviderProps,
} from '@mantine/core';
import React from 'react';

const useStyles = createStyles(() => ({
  htmlRenderer: {
    '& p:last-of-type': {
      marginBottom: 0,
    },
  },
}));

export function RenderHtml({ html, ...props }: Props) {
  const { classes } = useStyles();

  return (
    <TypographyStylesProvider {...props} className={classes.htmlRenderer}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesProvider>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & { html: string };
