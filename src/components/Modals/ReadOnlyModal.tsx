import { Button, Modal, Text, Title } from '@mantine/core';
import { IconWorldExclamation, IconAlertCircle } from '@tabler/icons-react';

import { useDialogContext } from '~/components/Dialog/DialogContext';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

export default function ReadOnlyModal() {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} withCloseButton={false} size="lg" centered>
      <div className="flex flex-col items-center justify-center gap-4 p-4">
        <div className="flex justify-center">
          <div className="rounded-full bg-amber-100 p-3">
            <IconWorldExclamation className="size-20 text-amber-600" />
          </div>
        </div>
        <Title order={1} className="text-2xl font-bold tracking-tight sm:text-3xl">
          We are in read-only mode
        </Title>
        <AlertWithIcon
          color="yellow"
          icon={<IconAlertCircle className="size-4" />}
          iconColor="yellow"
        >
          Due to a technical issue, we&apos;re temporarily in read-only mode. This means some
          features will be limited or unavailable.
        </AlertWithIcon>
        <div className="flex w-full flex-col justify-start gap-2">
          <div>
            <Text className="font-medium">Available</Text>
            <ul className="m-0 list-disc pl-8">
              <li>Browsing</li>
              <li>Generating</li>
              <li>Training</li>
              <li>Auctions</li>
            </ul>
          </div>
          <div>
            <Text className="font-medium">Unavailable</Text>
            <ul className="m-0 list-disc pl-8">
              <li>Publishing Posts</li>
              <li>Publishing Models</li>
              <li>Publishing Articles</li>
              <li>Publishing Bounties</li>
              <li>Submitting Bounty Entries</li>
              <li>Leaving Comments</li>
            </ul>
          </div>
          <div>
            <Text className="font-medium">Not updating </Text>
            <ul className="m-0 list-disc pl-8">
              <li>Reaction Counts</li>
              <li>Buzz Tip Counts</li>
              <li>Model Stats</li>
              <li>Content Feeds</li>
            </ul>
          </div>
        </div>

        <div className="flex w-full justify-center">
          <Button onClick={dialog.onClose} size="lg" fullWidth>
            Understood
          </Button>
        </div>
      </div>
    </Modal>
  );
}
