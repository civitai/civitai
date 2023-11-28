import {
  Box,
  Button,
  Center,
  Checkbox,
  createStyles,
  Divider,
  Group,
  Input,
  InputWrapperProps,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import React, { useMemo, useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { trpc } from '~/utils/trpc';
import { isEqual } from 'lodash-es';
import { ClubResourceSchema } from '~/server/schema/club.schema';

type ClubResourceManagementInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ClubResourceSchema[];
  onChange?: (value: ClubResourceSchema[]) => void;
};

export const ClubResourceManagementInput = ({
  value,
  onChange,
  ...props
}: ClubResourceManagementInputProps) => {
  const [error, setError] = useState<string | null>(null);
  const [selectedClubId, setSelectedClubId] = useState<number | null>(null);
  const [clubResources, setClubResources] = useState<ClubResourceSchema[]>(value || []);
  const { data: clubTiers = [], isFetching } = trpc.club.getTiers.useQuery(
    {
      clubIds: clubResources.map((i) => i.clubId),
    },
    {
      enabled: clubResources.length > 0,
      keepPreviousData: true,
    }
  );

  const { data: userClubs, isLoading: isLoadingUserClubs } =
    trpc.club.userContributingClubs.useQuery();

  useDidUpdate(() => {
    if (clubResources) {
      onChange?.(clubResources);
    }
  }, [clubResources]);

  useDidUpdate(() => {
    if (!isEqual(value, clubResources)) {
      // Value changed outside.
      setClubResources(value || []);
    }
  }, [value]);

  const onToggleClub = (clubId: number) => {
    setClubResources((current) =>
      current.find((c) => c.clubId === clubId)
        ? current.filter((c) => c.clubId !== clubId)
        : [...current, { clubId, clubTierIds: [] }]
    );
  };

  const onToggleTierId = (clubId: number, clubTierId: number) => {
    setClubResources((current) =>
      current.map((c) =>
        c.clubId === clubId
          ? {
              ...c,
              clubTierIds: (c.clubTierIds ?? []).includes(clubTierId)
                ? (c.clubTierIds ?? []).filter((ct) => ct !== clubTierId)
                : [...(c.clubTierIds ?? []), clubTierId],
            }
          : c
      )
    );
  };

  const onSetAllTierAccess = (clubId: number) => {
    setClubResources((current) =>
      current.map((c) =>
        c.clubId === clubId
          ? {
              ...c,
              clubTierIds: [],
            }
          : c
      )
    );
  };

  const unusedClubs = useMemo(() => {
    return userClubs?.filter((c) => !clubResources.find((cr) => cr.clubId === c.id)) ?? [];
  }, [clubResources, userClubs]);

  if (isLoadingUserClubs) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack spacing="xs" mt="sm">
        {unusedClubs.length === 0 ? (
          <Center>
            <Text color="dimmed" size="sm">
              Resource has been added to all clubs
            </Text>
          </Center>
        ) : (
          <Group grow align="flex-end">
            <Select
              label="My Clubs"
              name="myClubs"
              data={unusedClubs.map((c) => ({ label: c.name, value: c.id.toString() }))}
              onChange={(value: string) => setSelectedClubId(Number(value))}
              value={selectedClubId === null ? null : selectedClubId.toString()}
              disabled={isLoadingUserClubs || unusedClubs.length === 0}
            />
            <Button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleClub(selectedClubId as number);
                setSelectedClubId(null);
              }}
              disabled={!selectedClubId}
            >
              Add to this club
            </Button>
          </Group>
        )}
        {clubResources.map((clubResource, index) => {
          const tiers = clubTiers.filter((t) => t.clubId === clubResource.clubId);
          const clubTierIds = clubResource.clubTierIds ?? [];

          return (
            <Paper key={clubResource.clubId} p="sm" radius="md" withBorder>
              <Text size="sm" weight={500}>
                {userClubs?.find((c) => c.id === clubResource.clubId)?.name ?? 'Unknown Club'}
              </Text>
              <Stack spacing="xs" mt="sm">
                <Checkbox
                  label="All tiers"
                  checked={clubTierIds.length === 0}
                  onChange={() => {
                    onSetAllTierAccess(clubResource.clubId);
                  }}
                />
                {tiers.map((tier) => (
                  <Checkbox
                    key={tier.id}
                    label={tier.name}
                    checked={clubTierIds.includes(tier.id)}
                    onChange={() => onToggleTierId(clubResource.clubId, tier.id)}
                  />
                ))}
                {tiers.length === 0 ? (
                  isFetching ? (
                    <Loader />
                  ) : (
                    <Text color="dimmed" size="sm">
                      No tiers avilable for this club.
                    </Text>
                  )
                ) : null}
              </Stack>
              <Divider my="md" />
              <Button size="sm" onClick={() => onToggleClub(clubResource.clubId)} color="red">
                Remove from this club
              </Button>
            </Paper>
          );
        })}
      </Stack>
    </Input.Wrapper>
  );
};
