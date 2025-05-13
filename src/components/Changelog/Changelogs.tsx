import {
  Badge,
  Button,
  Card,
  Center,
  Collapse,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  MantineColor,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertCircle,
  IconExternalLink,
  IconMinus,
  IconPinFilled,
  IconPlus,
  IconPointFilled,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { clsx } from 'clsx';
import dayjs from 'dayjs';
import { isEqual } from 'lodash-es';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ChangelogFiltersDropdown } from '~/components/Changelog/ChangelogFiltersDropdown';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { createChangelogInput } from '~/server/schema/changelog.schema';
import type { Changelog } from '~/server/services/changelog.service';
import { ChangelogType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const changelogTypeMap: { [K in ChangelogType]: { color: MantineColor; text: string } } = {
  Bugfix: { color: 'grape', text: 'Bugfix' },
  Policy: { color: 'teal', text: 'Policy' },
  Feature: { color: 'green', text: 'Feature' },
  Update: { color: 'violet', text: 'Update' },
  Incident: { color: 'red', text: 'Incident' },
};

// nb: set your editor tailwind to `"classAttributes": [... ".*TWStyles"]` for this to populate
const titleGradientTWStyles = {
  blue: 'from-blue-800 to-purple-800 dark:from-blue-4 dark:to-purple-400',
  purple: 'from-purple-800 to-red-800 dark:from-purple-400 dark:to-red-3',
  red: 'from-red-800 to-orange-700 dark:from-red-3 dark:to-orange-4',
  orange: 'from-orange-700 to-yellow-600 dark:from-orange-4 dark:to-yellow-1',
  yellow: 'from-yellow-600 to-green-800 dark:from-yellow-1 dark:to-green-3',
  green: 'from-green-800 to-blue-800 dark:from-green-3 dark:to-blue-4',
} as Record<string, string>;

const ChangelogItem = ({
  item,
  canEdit,
  setEditingItem,
  setOpened,
  scrollRef,
  lastSeen,
}: {
  item: Changelog;
  canEdit: boolean;
  setEditingItem: React.Dispatch<React.SetStateAction<Changelog | undefined>>;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
  scrollRef: React.RefObject<HTMLDivElement> | undefined;
  lastSeen: number;
}) => {
  const queryUtils = trpc.useUtils();
  const { mutate: deleteItem } = trpc.changelog.delete.useMutation();

  const handleDelete = (id: number) => {
    openConfirmModal({
      title: 'Delete changelog',
      children: 'Are you sure you want to delete this changelog?',
      centered: true,
      labels: { confirm: 'Delete', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteItem(
          { id },
          {
            async onSuccess() {
              showSuccessNotification({
                message: 'Changelog deleted!',
              });

              await queryUtils.changelog.getInfinite.invalidate();
              await queryUtils.changelog.getAllTags.invalidate();
            },
            onError(error) {
              showErrorNotification({
                title: 'Failed to delete changelog',
                error: new Error(error.message),
              });
            },
          }
        );
      },
    });
  };

  const typeMapped = changelogTypeMap[item.type];
  const titleGradient = !item.titleColor
    ? titleGradientTWStyles['blue']
    : titleGradientTWStyles[item.titleColor] ?? titleGradientTWStyles['blue'];

  return (
    <Card withBorder shadow="sm" p="md" radius="md">
      <Card.Section withBorder inheritPadding py="md">
        <Stack spacing="sm">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
            <Badge
              color={typeMapped.color}
              size="lg"
              variant="light"
              className="mb-2 self-center sm:hidden"
            >
              {typeMapped.text}
            </Badge>

            <span className="min-w-0 flex-1 text-center sm:text-left">
              <span
                className={clsx(
                  'inline-block break-normal bg-gradient-to-r bg-clip-text text-lg font-bold text-transparent',
                  titleGradient
                )}
              >
                {lastSeen < item.effectiveAt.getTime() && (
                  <div className="mr-1 inline-block">
                    <Tooltip label="New" withArrow position="top" withinPortal>
                      <IconPointFilled color="green" size={18} />
                    </Tooltip>
                  </div>
                )}
                {item.sticky && (
                  <div className="mr-1 inline-block">
                    <Tooltip label="Sticky" withArrow position="top" withinPortal>
                      <IconPinFilled color="yellow" size={18} />
                    </Tooltip>
                  </div>
                )}
                {item.title}
              </span>
            </span>

            <Badge
              color={typeMapped.color}
              size="lg"
              variant="light"
              className="hidden sm:ml-4 sm:inline-flex"
            >
              {typeMapped.text}
            </Badge>
          </div>

          <Group position="apart">
            <Group spacing="xs">
              <Text size="md">{dayjs(item.effectiveAt).format('MMM DD, YYYY')}</Text>
              {item.updatedAt.getTime() > item.effectiveAt.getTime() && (
                <Text size="sm" color="dimmed">
                  Updated: {dayjs().to(dayjs(item.updatedAt))}
                </Text>
              )}
              {canEdit && item.disabled && (
                <Badge color="red" variant="light">
                  Disabled
                </Badge>
              )}
              {canEdit && item.effectiveAt > new Date() && (
                <Badge color="cyan" variant="light">
                  Future
                </Badge>
              )}
            </Group>
            {item.tags.length && (
              <Group spacing="xs">
                {item.tags.map((tag) => (
                  <Badge key={tag} color="blue" variant="light">
                    {tag}
                  </Badge>
                ))}
              </Group>
            )}
          </Group>
        </Stack>
      </Card.Section>

      <Card.Section withBorder inheritPadding py="md">
        <RenderHtml html={item.content} />
        {item.cta && (
          <div className="text-center">
            <Button
              component="a"
              href={item.cta}
              variant="light"
              color="blue"
              mt="md"
              radius="md"
              className="w-full sm:w-1/2"
            >
              Check it out
            </Button>
          </div>
        )}
      </Card.Section>

      {(item.link || canEdit) && (
        <Card.Section inheritPadding py="sm">
          <Group position="apart" className="w-full">
            <div>
              {canEdit && (
                <Group spacing="xs">
                  <Button
                    onClick={() => {
                      setEditingItem(item);
                      setOpened(true);
                      scrollRef?.current?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    Edit
                  </Button>
                  <Button color="red" onClick={() => handleDelete(item.id)}>
                    Delete
                  </Button>
                </Group>
              )}
            </div>
            {item.link && (
              <Button
                component="a"
                target="_blank"
                rel="noopener noreferrer"
                compact
                href={item.link}
                color="gray"
                variant="light"
                rightIcon={<IconExternalLink size={14} />}
              >
                More Info
              </Button>
            )}
          </Group>
        </Card.Section>
      )}
    </Card>
  );
};

const schema = createChangelogInput;
type SchemaType = z.infer<typeof schema>;
const defaultValues: SchemaType = {
  title: '',
  titleColor: 'blue',
  content: '',
  link: undefined,
  cta: undefined,
  effectiveAt: new Date(),
  type: ChangelogType.Feature,
  tags: [],
  disabled: false,
  sticky: false,
};

const CreateChangelog = ({
  existing,
  opened,
  setEditingItem,
  setOpened,
}: {
  existing?: Changelog;
  opened: boolean;
  setEditingItem: React.Dispatch<React.SetStateAction<Changelog | undefined>>;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
  const queryUtils = trpc.useUtils();

  const { data: tagData = [], isLoading: loadingTagData } = trpc.changelog.getAllTags.useQuery();

  const { mutate, isLoading } = trpc.changelog.create.useMutation();
  const { mutate: update, isLoading: isLoadingUpdate } = trpc.changelog.update.useMutation();

  const form = useForm({
    schema,
    defaultValues,
    shouldUnregister: false,
  });

  useEffect(() => {
    form.reset(
      !!existing
        ? {
            ...existing,
            link: existing.link ?? undefined,
            cta: existing.cta ?? undefined,
            titleColor: existing.titleColor ?? 'blue',
          }
        : defaultValues
    );
  }, [existing]);

  const formTags = form.watch('tags');
  const allTagData = useMemo(
    () => Array.from(new Set([...(formTags ?? []), ...tagData])),
    [formTags, tagData]
  );

  const handleClose = () => {
    form.reset(defaultValues);
    setEditingItem(undefined);
    setOpened(false);
  };

  const handleSubmit = async (data: SchemaType) => {
    if (!existing) {
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
            title: 'Failed to create changelog',
            error: new Error(error.message),
          });
        },
      });
    } else {
      const changed = Object.fromEntries(
        Object.entries(data).filter(
          ([key, value]) => !isEqual(value, existing[key as keyof Changelog])
        )
      ) as Partial<SchemaType>;
      update(
        {
          ...changed,
          id: existing.id,
        },
        {
          async onSuccess() {
            showSuccessNotification({
              message: 'Changelog updated!',
            });

            handleClose();

            await queryUtils.changelog.getInfinite.invalidate();
            await queryUtils.changelog.getAllTags.invalidate();
          },
          onError(error) {
            showErrorNotification({
              title: 'Failed to update changelog',
              error: new Error(error.message),
            });
          },
        }
      );
    }
  };

  return (
    <div className="my-2">
      <Divider mb="lg" />

      <Button
        px="lg"
        leftIcon={opened ? <IconMinus /> : <IconPlus />}
        onClick={() => setOpened((o) => !o)}
      >
        {opened ? 'Hide' : !!existing ? 'Update' : 'Create New'}
      </Button>

      <Collapse in={opened}>
        <Form form={form} onSubmit={handleSubmit}>
          <Paper withBorder mt="md" p="lg">
            <Stack spacing="lg">
              <InputText name="title" label="Title" placeholder="Title..." withAsterisk />
              <InputSelect
                name="titleColor"
                label="Title Color"
                data={Object.keys(titleGradientTWStyles)}
              />
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
                data={allTagData}
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
              <InputCheckbox name="sticky" label="Sticky" />
              <Group position="right">
                <Button variant="default" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="submit" loading={isLoading || isLoadingUpdate}>
                  {!!existing ? 'Update' : 'Create'}
                </Button>
              </Group>
            </Stack>
          </Paper>
        </Form>
      </Collapse>
    </div>
  );
};

export function Changelogs() {
  const features = useFeatureFlags();
  const { filters: clFilters, setFilters } = useFiltersContext((state) => ({
    filters: state.changelogs,
    setFilters: state.setChangelogFilters,
  }));
  const [searchTxt, setSearchTxt] = useState('');
  const [createOpened, setCreateOpened] = useState(false);
  const [editingItem, setEditingItem] = useState<Changelog | undefined>();
  const [lastSeenChangelog, setLastSeenChangelog] = useLocalStorage<number>({
    key: 'last-seen-changelog',
    defaultValue: 0, // -1
    getInitialValueInEffect: false,
  });
  const ref = useRef<HTMLDivElement>(null);
  const lastSeenRef = useRef<number>(lastSeenChangelog);

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
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 400);

  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isRefetching } =
    trpc.changelog.getInfinite.useInfiniteQuery(
      { ...debouncedFilters },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: true,
        // trpc: { context: { skipBatch: true } },
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  useEffect(() => {
    if (!flatData?.length) return;
    const latest = Math.max(...flatData.map((item) => item.effectiveAt.getTime()));
    if (latest > lastSeenChangelog) setLastSeenChangelog(latest);
  }, [flatData, lastSeenChangelog, setLastSeenChangelog]);

  const isAsc = filters.sortDir === 'asc';
  const canEdit = features.changelogEdit;

  return (
    <Stack ref={ref}>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Text size={26} weight="bold" className="w-full text-left sm:w-auto">
          Updates
        </Text>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          <TextInputWrapper
            value={searchTxt}
            onChange={(event) => setSearchTxt(event.currentTarget.value)}
            placeholder="Search titles and content..."
            className="w-full sm:mr-2 sm:w-[300px]"
          />

          <div className="flex w-full flex-row justify-end gap-2 sm:w-auto">
            <Button
              variant="light"
              className="rounded-3xl"
              size="sm"
              p="sm"
              onClick={() => setFilters({ ...filters, sortDir: isAsc ? 'desc' : 'asc' })}
            >
              {isAsc ? <IconSortAscending size={18} /> : <IconSortDescending size={18} />}
            </Button>
            <ChangelogFiltersDropdown />
          </div>
        </div>
      </div>

      {/* Create */}
      {canEdit && (
        <CreateChangelog
          opened={createOpened}
          setOpened={setCreateOpened}
          existing={editingItem}
          setEditingItem={setEditingItem}
        />
      )}

      <Divider mb="md" />

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

          <Stack spacing="xl">
            {flatData.map((c) => (
              <ChangelogItem
                key={c.id}
                item={c}
                canEdit={canEdit}
                setEditingItem={setEditingItem}
                setOpened={setCreateOpened}
                scrollRef={ref}
                lastSeen={lastSeenRef.current}
              />
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
        <NoContent my="lg" />
      )}
    </Stack>
  );
}
