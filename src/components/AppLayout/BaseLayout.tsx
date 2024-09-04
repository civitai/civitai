import { useMantineTheme } from '@mantine/core';
import React from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';
import { MetaPWA } from '~/components/Meta/MetaPWA';

export function BaseLayout({ children }: { children: React.ReactNode }) {
  const theme = useMantineTheme();

  return (
    <>
      <MetaPWA />
      <div className={`flex size-full ${theme.colorScheme}`}>
        <GenerationSidebar />
        <ContainerProvider id="main" containerName="main" className="flex-1">
          {children}
        </ContainerProvider>
      </div>
    </>
  );
}
