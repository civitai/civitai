import React from 'react';
import { trpc } from '~/utils/trpc';
import { Button, Center, Divider, Loader, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ClubMembershipStatus, ClubTierItem } from '../ClubTierItem';
import Link from 'next/link';
import { IconClubs } from '@tabler/icons-react';

type Props = {
  clubId: number;
  clubTierIds?: number[];
};

export const ManageClubMembershipModal = ({ clubId, clubTierIds }: Props) => {
  const dialog = useDialogContext();

  const { data: club, isLoading: isLoadingClub } = trpc.club.getById.useQuery({ id: clubId });
  const { data: tiers = [], isLoading: isLoadingTiers } = trpc.club.getTiers.useQuery({
    clubId,
    listedOnly: true,
    joinableOnly: true,
  });

  const availableClubTiers = tiers.filter((tier) => {
    if (!clubTierIds) {
      return true;
    }

    return clubTierIds.includes(tier.id);
  });

  const isLoading = isLoadingClub || isLoadingTiers;
  const handleClose = dialog.onClose;

  return (
    <Modal {...dialog} size="md" withCloseButton title="Manage club membership">
      <Divider mx="-lg" mb="md" />

      {isLoading ? (
        <Center>
          <Loader variant="bars" />
        </Center>
      ) : club ? (
        <Stack spacing="md">
          <Text>
            Manage your club membership on club{' '}
            <Text component="span" weight="bold">
              {club.name}
            </Text>
          </Text>
          <ClubMembershipStatus clubId={clubId} />
          {availableClubTiers.length > 0 ? (
            <>
              {availableClubTiers.map((tier) => (
                <ClubTierItem key={tier.id} clubTier={tier} />
              ))}
            </>
          ) : (
            <Text color="dimmed" size="sm">
              The owner of this club has not added any club tiers yet.
            </Text>
          )}
        </Stack>
      ) : (
        <Text color="dimmed">This club does not exist.</Text>
      )}

      <Divider
        mx="-lg"
        mt="md"
        mb="md"
        label="Would you like more information?"
        labelPosition="center"
      />
      <Link href={`/clubs/${clubId}`} passHref>
        <Button fullWidth onClick={handleClose} leftIcon={<IconClubs size={16} />}>
          Check this club&rsquo;s page
        </Button>
      </Link>
    </Modal>
  );
};
