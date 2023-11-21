import { Box, Button, Container, Group, Modal, Stack, Title } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useState } from 'react';
import { create } from 'zustand';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { Countdown } from '~/components/Countdown/Countdown';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { constants } from '~/server/common/constants';

const useStore = create(() => ({ foo: true, bar: true, test: true, count: 0 }));

const date = new Date();
const offset = new Date(date.getTime() + 10 * 60000);
export default function Test() {
  const [state, setState] = useState(0);

  useInterval(() => setState((state) => state + 1), 1000);

  return (
    <Container size="xs">
      <Stack>
        <Countdown endTime={offset} format="short"></Countdown>
        <Button onClick={() => dialogStore.trigger({ component: ModalA })}>Modal</Button>

        <RoutedDialogLink name="imageDetail" state={{ imageId: 2485691 }} passHref>
          <a>
            <h1>Route Dialog Link</h1>
            <h2>Heading 2</h2>
          </a>
        </RoutedDialogLink>
      </Stack>
    </Container>
  );
}

// setPageOptions(Test, {
//   innerLayout: (children) => <div style={{ background: 'red' }}>{children}</div>,
// });

const ModalA = () => {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} size={900}>
      <Box p="xl">
        <Button onClick={() => dialogStore.trigger({ component: ModalB })}>Modal</Button>
      </Box>
    </Modal>
  );
};

const ModalB = () => {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog}>
      <Box p="xl">
        <Title>Hello World</Title>
      </Box>
    </Modal>
  );
};
