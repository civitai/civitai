import {
  Anchor,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconLock, IconLockOpen, IconStar } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';
import { BountyEntryGetById } from '~/types/router';
import { formatKBytes } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';

type Props = { bountyEntry: Omit<BountyEntryGetById, 'files'> };

const { openModal: openBountyEntryFilesModal, Modal } = createContextModal<Props>({
  name: 'bountyEntryFiles',
  title: 'Files',
  size: 'md',
  Element: ({ props }) => {
    return <BountyEntryFiles {...props} />;
  },
});

export { openBountyEntryFilesModal };
export default Modal;

function BountyEntryFiles({ bountyEntry }: Props) {
  const { data: files, isLoading } = trpc.bountyEntry.getFiles.useQuery({ id: bountyEntry.id });

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!files?.length) {
    return (
      <Stack>
        <Text>Looks like this entry contains no files.</Text>
      </Stack>
    );
  }

  const hasLockedFiles = files.find(
    (file) => (file.metadata.unlockAmount ?? 0) > bountyEntry.awardedUnitAmountTotal
  );

  return (
    <Stack>
      {hasLockedFiles && (
        <Text>
          Some of the files in this entry are still because they have not reached the unlock amount.
        </Text>
      )}
      <ScrollArea.Autosize maxHeight={400}>
        <Stack spacing="md">
          {files.map((file) => {
            const isLocked = (file.metadata.unlockAmount ?? 0) > bountyEntry.awardedUnitAmountTotal;

            return (
              <Paper key={file.id} p={16} radius="md" w="100%" bg="dark.4">
                <Stack>
                  <Group position="apart">
                    <Group>
                      {isLocked ? (
                        <Tooltip
                          label="This file has not been unlocked yet"
                          maw={200}
                          multiline
                          withArrow
                          withinPortal
                        >
                          <IconLock />
                        </Tooltip>
                      ) : (
                        <IconLockOpen />
                      )}
                      <Stack spacing={0}>
                        {file.url && !isLocked ? (
                          <Anchor
                            href={`/api/download/attachments/${file.id}`}
                            lineClamp={1}
                            download
                            size="sm"
                          >
                            {file.name}
                          </Anchor>
                        ) : (
                          <Text size="sm" weight={500} lineClamp={1}>
                            {file.name}
                          </Text>
                        )}
                        <Text color="dimmed" size="xs">
                          {formatKBytes(file.sizeKB)}
                        </Text>
                      </Stack>
                    </Group>

                    <Group spacing={0}>
                      {file.metadata.benefactorsOnly && (
                        <Tooltip
                          label="Only users who award this entry will have access to this file"
                          maw={200}
                          multiline
                          withArrow
                          withinPortal
                        >
                          <ThemeIcon color="yellow.6" radius="xl" size="sm" variant="light">
                            <IconStar size={12} />
                          </ThemeIcon>
                        </Tooltip>
                      )}
                      {(file.metadata.unlockAmount ?? 0) > 0 && (
                        <CurrencyBadge
                          currency={file.metadata.currency ?? Currency.BUZZ}
                          unitAmount={file.metadata.unlockAmount ?? 0}
                        />
                      )}
                    </Group>
                  </Group>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
