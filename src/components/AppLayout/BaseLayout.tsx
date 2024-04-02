import { useMantineTheme } from '@mantine/core';
import React from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';

export function BaseLayout({ children }: { children: React.ReactNode }) {
  const theme = useMantineTheme();
  return (
    <div className={`flex h-full w-full theme-${theme.colorScheme}`}>
      <GenerationSidebar />
      <ContainerProvider containerName="main" className="flex-1">
        {children}
      </ContainerProvider>
    </div>
  );
}
