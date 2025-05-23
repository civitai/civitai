import React from 'react';
import { trpc } from '~/utils/trpc';
import { Button, Center, Divider, Loader, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ClubMembershipStatus, ClubTierItem } from '../ClubTierItem';
import { NextLink as Link } from '~/components/NextLink/NextLink';
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
        <Stack gap="md">
          <Text>
            Manage your club membership on club{' '}
            <Text component="span" fw="bold">
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
            <Text c="dimmed" size="sm">
              The owner of this club has not added any club tiers yet.
            </Text>
          )}
        </Stack>
      ) : (
        <Text c="dimmed">This club does not exist.</Text>
      )}

      <Divider
        mx="-lg"
        mt="md"
        mb="md"
        label="Would you like more information?"
        labelPosition="center"
      />
      <Link legacyBehavior href={`/clubs/${clubId}`} passHref>
        <Button fullWidth onClick={handleClose} leftSection={<IconClubs size={16} />}>
          Check this club&rsquo;s page
        </Button>
      </Link>
    </Modal>
  );
};
