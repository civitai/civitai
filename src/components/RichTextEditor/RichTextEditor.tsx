import dynamic from 'next/dynamic';
import { Skeleton } from '@mantine/core';
import React from 'react';

const RichTextEditor = dynamic(
  () => import('~/components/RichTextEditor/RichTextEditorComponent').then((x) => x.RichTextEditor),
  {
    ssr: false,
    loading: () => <Skeleton height={50} animate />,
  }
);

export { RichTextEditor };
