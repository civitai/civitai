import { Stack, Center, ThemeIcon, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { GenerateFormLogic } from '~/components/ImageGeneration/GenerationForm/GenerateFormLogic';
import { IconLock } from '@tabler/icons-react';

export function Generate2() {
  const currentUser = useCurrentUser();

  if (currentUser?.muted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">You cannot create new generations because you have been muted</Text>
        </Stack>
      </Center>
    );

  return <GenerateFormLogic />;
}
