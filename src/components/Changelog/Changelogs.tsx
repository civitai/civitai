import {
  Button,
  Center,
  Collapse,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconMinus,
  IconPlus,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import React, { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ChangelogFiltersDropdown } from '~/components/Changelog/ChangelogFiltersDropdown';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputMultiSelect,
  InputRTE,
  InputSelect,
  InputText,
  useForm,
} from '~/libs/form';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { createChangelogInput } from '~/server/schema/changelog.schema';
import type { Changelog } from '~/server/services/changelog.service';
import { ChangelogType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const ChangelogItem = ({ item }: { item: Changelog }) => {
  return (
    <div>
      <Text size="sm" color="dimmed">
        {item.effectiveAt.toLocaleDateString()}
      </Text>
      <Text size="lg" weight={700}>
        {item.title}
      </Text>
      <Text size="sm" color="dimmed"></Text>
    </div>
  );
};

const schema = createChangelogInput;
type SchemaType = z.infer<typeof schema>;
const defaultValues: SchemaType = {
  title: '',
  content: '',
  link: undefined,
  cta: undefined,
  effectiveAt: new Date(),
  type: ChangelogType.Feature,
  tags: [],
  disabled: false,
};

const CreateChangelog = () => {
  const queryUtils = trpc.useUtils();
  const [opened, setOpened] = useState(false);

  const { data: tagData = [], isLoading: loadingTagData } = trpc.changelog.getAllTags.useQuery();

  const { mutate, isLoading } = trpc.changelog.create.useMutation();

  // TODO how to edit

  const form = useForm({
    schema,
    defaultValues,
    // shouldUnregister: false,
  });

  const handleClose = () => {
    form.reset(defaultValues);
    setOpened(false);
  };

  const handleSubmit = async (data: SchemaType) => {
    mutate(removeEmpty(data, true), {
      async onSuccess() {
        showSuccessNotification({
          message: 'Changelog created!',
        });

        handleClose();

        await queryUtils.changelog.getInfinite.invalidate();
        await queryUtils.changelog.getAllTags.invalidate();
      },
      onError(error) {
        showErrorNotification({
          title: 'Failed to create article',
          error: new Error(error.message),
        });
      },
    });
  };

  return (
    <>
      <Button leftIcon={opened ? <IconMinus /> : <IconPlus />} onClick={() => setOpened((o) => !o)}>
        {opened ? 'Hide' : 'Create New'}
      </Button>

      <Collapse in={opened}>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="lg">
            <InputText name="title" label="Title" placeholder="Title..." withAsterisk />
            <InputRTE
              name="content"
              label="Content"
              editorSize="xl"
              includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']} // mentions, polls
              withAsterisk
              stickyToolbar
            />
            <InputDatePicker
              name="effectiveAt"
              label="Effective at"
              placeholder="Select a date"
              withAsterisk
            />
            <InputSelect
              name="type"
              label="Type"
              withAsterisk
              data={Object.values(ChangelogType)}
            />
            <InputMultiSelect
              name="tags"
              label="Tags"
              data={tagData}
              loading={loadingTagData}
              limit={50}
              placeholder="Tags..."
              getCreateLabel={(query) => `+ Create ${query}`}
              creatable
              clearable
              searchable
            />
            <InputText name="link" label="Link" placeholder="Link to commit/article..." />
            <InputText name="cta" label="CTA" placeholder="Link for CTA..." />
            <InputCheckbox name="disabled" label="Disabled" />
            <Group position="right">
              <Button variant="default" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" loading={isLoading}>
                {!true ? 'Save' : 'Create'}
              </Button>
            </Group>
          </Stack>
        </Form>
      </Collapse>
    </>
  );
};

export function Changelogs() {
  const { classes } = useFeedFiltersStyles();
  const currentUser = useCurrentUser();
  const { filters: clFilters, setFilters } = useFiltersContext((state) => ({
    filters: state.changelogs,
    setFilters: state.setChangelogFilters,
  }));
  const [searchTxt, setSearchTxt] = useState('');

  const filters = useMemo(
    () =>
      removeEmpty(
        {
          ...clFilters,
          search: searchTxt.length > 0 ? searchTxt : undefined,
        },
        true
      ),
    [clFilters, searchTxt]
  );
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isRefetching } =
    trpc.changelog.getInfinite.useInfiniteQuery(
      { ...filters },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: true,
        // trpc: { context: { skipBatch: true } },
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  const isAsc = filters.sortDir === 'asc';

  return (
    <Stack>
      {/* Filters */}
      <Group className={classes.filtersWrapper} spacing={8} noWrap>
        <TextInputWrapper
          value={searchTxt}
          onChange={(event) => {
            setSearchTxt(event.currentTarget.value);
          }}
          label="Search"
          placeholder="Search titles and content..."
        />
        <Button
          rightIcon={isAsc ? <IconSortAscending size={18} /> : <IconSortDescending size={18} />}
          onClick={() => setFilters({ ...filters, sortDir: isAsc ? 'desc' : 'asc' })}
        >
          {isAsc ? 'New' : 'Old'}
        </Button>
        <ChangelogFiltersDropdown />
      </Group>

      {/* Create */}
      {currentUser?.isModerator && (
        <>
          <CreateChangelog />
          <Divider />
        </>
      )}

      {/* Data */}
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : isError ? (
        <Center p="xl">
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching the changelog data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !!flatData?.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <Stack>
            {flatData.map((c) => (
              <ChangelogItem key={c.id} item={c} />
            ))}
          </Stack>

          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
              <Center p="xl" sx={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && Object.keys(filters).filter((x) => x !== 'sortDir').length > 0 && (
            <EndOfFeed text="Consider changing your filters to find more" />
          )}
        </div>
      ) : (
        <NoContent />
      )}
    </Stack>
  );
}
