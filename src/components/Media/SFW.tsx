import { Box, BoxProps } from '@mantine/core';
import React from 'react';
import { MediaCount } from './MediaCount';
import { SfwCtx, MediaTypes } from './sfwContext';
import { useSfwStore } from './sfwStore';
import { MediaNsfwToggle } from './MediaNsfwToggle';
import { SfwContent } from './sfwContent';
import { SfwToggle } from './SfwToggle';
import { SfwPlaceholder } from './SfwPlaceholder';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type SFWProps = {
  nsfw?: boolean;
  type: MediaTypes;
  id: number;
  children?:
    | React.ReactNode
    | (({ nsfw, showNsfw }: { nsfw: boolean; showNsfw: boolean }) => React.ReactNode);
};

export function SFW({
  nsfw = false,
  type,
  id,
  children,
  sx = {},
  ...props
}: SFWProps & Omit<BoxProps, 'children'>) {
  const user = useCurrentUser();
  const shouldBlur = user?.blurNsfw ?? true;

  const showNsfw = useSfwStore(
    (state) => state[type === 'model' ? 'showModels' : 'showReviews'][id.toString()] ?? false
  );

  return (
    <SfwCtx.Provider value={{ nsfw: nsfw && shouldBlur, showNsfw, type, id }}>
      <Box
        sx={
          (theme) =>
          ({ position: 'relative', ...(typeof sx === 'function' ? sx(theme) : sx) } as any) //eslint-disable-line
        }
        {...props}
      >
        {typeof children === 'function'
          ? children({ nsfw: nsfw && shouldBlur, showNsfw })
          : children}
      </Box>
    </SfwCtx.Provider>
  );
}

SFW.ToggleNsfw = MediaNsfwToggle;
SFW.Count = MediaCount;
SFW.Content = SfwContent;
SFW.Toggle = SfwToggle;
SFW.Placeholder = SfwPlaceholder;
