import {
  Box,
  Button,
  Center,
  Checkbox,
  Chip,
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
import { useQueryUserContributingClubs } from './club.utils';

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

  const { userClubs, isLoading: isLoadingUserClubs } = useQueryUserContributingClubs();

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
        {(userClubs ?? []).map((club) => {
          const clubResource = clubResources.find((cr) => cr.clubId === club.id);
          const tiers = clubTiers.filter((t) => t.clubId === club.id);
          const clubTierIds = clubResource?.clubTierIds ?? [];

          return (
            <Stack key={club.id}>
              <Checkbox
                checked={!!clubResource}
                onChange={() => {
                  onToggleClub(club.id);
                }}
                label={club.name}
              />
              {clubResource && (
                <Group>
                  <Chip
                    variant="filled"
                    radius="xs"
                    size="xs"
                    checked={clubTierIds.length === 0}
                    onChange={() => {
                      onSetAllTierAccess(club.id);
                    }}
                  >
                    All tiers
                  </Chip>
                  {tiers.length === 0 ? (
                    isFetching ? (
                      <Loader size="xs" />
                    ) : (
                      <Text color="dimmed" size="sm">
                        No tiers avilable for this club.
                      </Text>
                    )
                  ) : null}
                  {tiers.length > 0 && (
                    <>
                      {tiers.map((t) => (
                        <Chip
                          key={t.id}
                          variant="filled"
                          radius="xs"
                          size="xs"
                          checked={clubResource.clubTierIds?.includes(t.id)}
                          onChange={() => {
                            onToggleTierId(club.id, t.id);
                          }}
                        >
                          {t.name}
                        </Chip>
                      ))}
                    </>
                  )}
                </Group>
              )}
              <Divider />
            </Stack>
          );
        })}
      </Stack>
    </Input.Wrapper>
  );
};
