import { keepPreviousData } from '@tanstack/react-query';
import type { MantineColor } from '@mantine/core';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Collapse,
  Divider,
  Group,
  HoverCard,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconExternalLink,
  IconLink,
  IconMinus,
  IconPlus,
  IconPointFilled,
  IconSortAscending,
  IconSortDescending,
  IconUserExclamation,
} from '@tabler/icons-react';
import { clsx } from 'clsx';
import { isEqual } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BugReportChart } from '~/components/Bug/BugReportChart';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import {
  Form,
  InputCheckbox,
  InputCreatableMultiSelect,
  InputDatePicker,
  InputMultiSelect,
  InputRTE,
  InputSelect,
  InputText,
  useForm,
} from '~/libs/form';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BUG_STATUS_SUGGESTIONS } from '~/server/common/constants';
import { createBugInput } from '~/server/schema/bug.schema';
import type { Bug } from '~/server/services/bug.service';
import dayjs from '~/shared/utils/dayjs';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const statusBadgeColor = (status: string): MantineColor => {
  const s = status.trim().toLowerCase();
  if (['complete', 'closed', 'done', 'resolved'].includes(s)) return 'green';
  if (['in review', 'qa review', 'pending review', 'review'].includes(s)) return 'yellow';
  if (['in progress', 'in-progress', 'working'].includes(s)) return 'blue';
  return 'grape';
};

const BugReportButton = ({
  bug,
  onReported,
}: {
  bug: Bug;
  onReported: (newCount: number) => void;
}) => {
  const [reportedAt, setReportedAt] = useLocalStorage<number>({
    key: `bug-reported-${bug.id}`,
    defaultValue: 0,
    getInitialValueInEffect: false,
  });
  const { mutate, isPending: isLoading } = trpc.bug.report.useMutation({
    onSuccess: (data) => {
      onReported(data.reportCount);
      setReportedAt(Date.now());
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not record your report',
        error: new Error(error.message),
      });
    },
  });

  const recentlyReported = reportedAt && Date.now() - reportedAt < 1000 * 60 * 60 * 24;

  return (
    <HoverCard width={260} withArrow withinPortal shadow="md" openDelay={200}>
      <HoverCard.Target>
        {/* span wrapper keeps the hover working even while the button is disabled */}
        <span className="inline-flex">
          <Button
            size="compact-sm"
            leftSection={<IconUserExclamation size={14} />}
            variant={recentlyReported ? 'light' : 'filled'}
            color={recentlyReported ? 'gray' : 'red'}
            loading={isLoading}
            disabled={!!recentlyReported}
            onClick={() => mutate({ bugId: bug.id })}
          >
            {recentlyReported ? 'Reported' : "I'm experiencing this"}{' '}
            <Badge ml={6} size="xs" variant="filled" color="dark">
              {bug.reportCount}
            </Badge>
          </Button>
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="sm">
          <Text span fw={600}>
            {bug.reportCount}
          </Text>{' '}
          {bug.reportCount === 1 ? 'person has' : 'people have'} run into this in the last 24 hours.
          {recentlyReported
            ? " Thanks for letting us know - you're counted."
            : " Hit the button if you're seeing it too so we know how many are affected."}
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
};

const BugItem = ({
  item,
  canEdit,
  setEditingItem,
  setOpened,
  scrollRef,
  lastSeen,
  reportPoints,
}: {
  item: Bug;
  canEdit: boolean;
  setEditingItem: React.Dispatch<React.SetStateAction<Bug | undefined>>;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
  scrollRef: React.RefObject<HTMLDivElement> | undefined;
  lastSeen: number;
  reportPoints?: { date: string; users: number }[];
}) => {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const { copy } = useClipboard();
  const { mutate: deleteItem } = trpc.bug.delete.useMutation();
  const [localCount, setLocalCount] = useState(item.reportCount);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => setLocalCount(item.reportCount), [item.reportCount]);

  const handleDelete = (id: number) => {
    openConfirmModal({
      title: 'Delete bug',
      children: 'Are you sure you want to delete this bug entry?',
      centered: true,
      labels: { confirm: 'Delete', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteItem(
          { id },
          {
            async onSuccess() {
              showSuccessNotification({ message: 'Bug deleted' });
              await queryUtils.bug.getInfinite.invalidate();
            },
            onError(error) {
              showErrorNotification({
                title: 'Failed to delete bug',
                error: new Error(error.message),
              });
            },
          }
        );
      },
    });
  };

  const [isHighlighted, setIsHighlighted] = useState<string>();

  useEffect(() => {
    const { id } = router.query as { id?: string };
    setIsHighlighted(id);
    if (id) {
      const elem = document.getElementById(id);
      if (elem) elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    }
  }, [router.query]);

  const slug = `${item.id}`;
  const badgeColor = statusBadgeColor(item.status);
  const isNew = lastSeen < item.updatedAt.getTime();

  return (
    <Card
      withBorder
      shadow="sm"
      p="md"
      radius="md"
      id={slug}
      className={clsx(isHighlighted === slug && 'shadow-[0_0_7px_3px] !shadow-blue-8')}
    >
      <Card.Section withBorder inheritPadding py="md">
        <Stack gap={4}>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
            <Badge
              color={badgeColor}
              size="lg"
              variant="light"
              className="mb-2 self-center sm:hidden"
            >
              {item.status}
            </Badge>

            <span className="min-w-0 flex-1 text-center sm:text-left">
              <span className="inline-block text-lg font-bold">
                {isNew && (
                  <div className="mr-1 inline-block">
                    <Tooltip label="Updated" color="dark" withArrow withinPortal>
                      <IconPointFilled color="green" size={18} />
                    </Tooltip>
                  </div>
                )}
                {item.title}
              </span>
            </span>

            <Group gap="xs" className="hidden sm:ml-4 sm:inline-flex">
              <ActionIcon
                size="sm"
                color="gray"
                variant="transparent"
                onClick={() =>
                  copy(`${window.location.href.split('?')[0].split('#')[0]}?id=${slug}`)
                }
                title="Copy link to this bug"
              >
                <IconLink size={16} />
              </ActionIcon>
              <Badge color={badgeColor} size="lg" variant="light">
                {item.status}
              </Badge>
            </Group>
          </div>

          <Group gap="xs" align="center">
            <Text size="xs" c="dimmed">
              First seen {dayjs(item.firstSeenAt).format('MMM DD, YYYY')}
            </Text>
            {item.tags.length > 0 &&
              item.tags.map((tag) => (
                <Badge key={tag} size="xs" color="blue" variant="light">
                  {tag}
                </Badge>
              ))}
            {isNew && (
              <Text size="xs" c="dimmed">
                Updated {dayjs(item.updatedAt).format('MMM DD, YYYY')}
              </Text>
            )}
            {item.resolvedAt && (
              <Text size="xs" c="dimmed">
                Resolved {dayjs(item.resolvedAt).format('MMM DD, YYYY')}
              </Text>
            )}
            {canEdit && item.disabled && (
              <Badge size="xs" color="red" variant="light">
                Disabled
              </Badge>
            )}
            {canEdit && !item.publishedAt && (
              <Badge size="xs" color="cyan" variant="light">
                Draft
              </Badge>
            )}
          </Group>

          <div className="mt-1">
            <Text component="span">{item.summary}</Text>
            {item.content && (
              <Button
                variant="subtle"
                color="blue"
                size="compact-xs"
                ml={6}
                onClick={() => setDetailsOpen((o) => !o)}
              >
                {detailsOpen ? 'Hide details' : 'Show details'}
              </Button>
            )}
          </div>
          {item.content && (
            <Collapse in={detailsOpen}>
              <Divider mx="-md" my="sm" />
              <RenderHtml html={item.content} />
            </Collapse>
          )}
        </Stack>
      </Card.Section>

      {canEdit && !!reportPoints?.length && (
        <Card.Section withBorder inheritPadding py="sm">
          <BugReportChart points={reportPoints} />
        </Card.Section>
      )}

      <Card.Section inheritPadding py="sm">
        <Group justify="space-between" className="w-full">
          <BugReportButton
            bug={{ ...item, reportCount: localCount }}
            onReported={(c) => setLocalCount(c)}
          />
          <Group gap="xs">
            {canEdit && item.clickupUrl && (
              <Button
                component="a"
                href={item.clickupUrl}
                target="_blank"
                rel="noopener noreferrer"
                size="compact-sm"
                variant="light"
                color="gray"
                rightSection={<IconExternalLink size={14} />}
              >
                ClickUp
              </Button>
            )}
            {canEdit && (
              <>
                <Button
                  size="compact-sm"
                  variant="light"
                  onClick={() => {
                    setEditingItem(item);
                    setOpened(true);
                    scrollRef?.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="compact-sm"
                  variant="light"
                  color="red"
                  onClick={() => handleDelete(item.id)}
                >
                  Delete
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Card.Section>
    </Card>
  );
};

const schema = createBugInput;
type SchemaType = z.infer<typeof schema>;
const defaultValues: SchemaType = {
  title: '',
  summary: '',
  content: undefined,
  status: 'Open',
  clickupUrl: undefined,
  publishedAt: new Date(),
  tags: [],
  disabled: false,
  domain: [DomainColor.all],
};

const CreateBug = ({
  existing,
  opened,
  setEditingItem,
  setOpened,
}: {
  existing?: Bug;
  opened: boolean;
  setEditingItem: React.Dispatch<React.SetStateAction<Bug | undefined>>;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
  const queryUtils = trpc.useUtils();
  const { mutate, isPending: isLoading } = trpc.bug.create.useMutation();
  const { mutate: update, isPending: isLoadingUpdate } = trpc.bug.update.useMutation();

  const form = useForm({
    schema,
    defaultValues: {
      title: existing?.title || defaultValues.title,
      summary: existing?.summary || defaultValues.summary,
      content: existing?.content || defaultValues.content,
      status: existing?.status || defaultValues.status,
      publishedAt: existing?.publishedAt
        ? new Date(existing.publishedAt)
        : defaultValues.publishedAt,
      clickupUrl: existing?.clickupUrl || defaultValues.clickupUrl,
      tags: existing?.tags || defaultValues.tags,
      disabled: existing?.disabled || defaultValues.disabled,
      domain: existing?.domain || defaultValues.domain,
    },
    shouldUnregister: false,
  });

  const handleClose = () => {
    form.reset(defaultValues);
    setEditingItem(undefined);
    setOpened(false);
  };

  const handleSubmit = async (data: SchemaType) => {
    if (!existing) {
      mutate(removeEmpty(data, true), {
        async onSuccess() {
          showSuccessNotification({ message: 'Bug created' });
          handleClose();
          await queryUtils.bug.getInfinite.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to create bug',
            error: new Error(error.message),
          });
        },
      });
    } else {
      const changed = Object.fromEntries(
        Object.entries(data).filter(([key, value]) => !isEqual(value, existing[key as keyof Bug]))
      ) as Partial<SchemaType>;
      update(
        { ...changed, id: existing.id },
        {
          async onSuccess() {
            showSuccessNotification({ message: 'Bug updated' });
            handleClose();
            await queryUtils.bug.getInfinite.invalidate();
          },
          onError(error) {
            showErrorNotification({
              title: 'Failed to update bug',
              error: new Error(error.message),
            });
          },
        }
      );
    }
  };

  return (
    <div className="my-2">
      <Collapse in={opened}>
        <Form form={form} onSubmit={handleSubmit}>
          <Paper withBorder mt="md" p="lg">
            <Stack gap="lg">
              <InputText name="title" label="Title" placeholder="Short title..." withAsterisk />
              <InputText
                name="summary"
                label="Summary"
                placeholder="One-line public statement..."
                withAsterisk
              />
              <InputRTE
                name="content"
                label="Details (optional)"
                editorSize="xl"
                includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                stickyToolbar
              />
              <InputSelect
                name="status"
                label="Status"
                description="Pick a suggestion or type your own"
                data={[...BUG_STATUS_SUGGESTIONS]}
                searchable
                allowDeselect={false}
                withAsterisk
              />
              <InputText
                name="clickupUrl"
                label="ClickUp URL"
                description="Optional link to the internal ClickUp task"
                placeholder="https://app.clickup.com/t/..."
              />
              <InputDatePicker
                name="publishedAt"
                label="Published at"
                description="Leave blank to keep as a mod-only draft"
                placeholder="Select a date"
                clearable
              />
              <InputCreatableMultiSelect
                name="tags"
                label="Tags"
                data={[]}
                placeholder="Tags..."
                clearable
              />
              <InputMultiSelect
                name="domain"
                label="Domain"
                description="Which domains this bug shows on"
                data={[
                  { value: 'red', label: 'Red Server' },
                  { value: 'green', label: 'Green Server' },
                  { value: 'blue', label: 'Blue Server' },
                  { value: 'all', label: 'All Servers' },
                ]}
                placeholder="Select domains..."
                searchable
                clearable
              />
              <InputCheckbox name="disabled" label="Disabled" />
              <Group justify="flex-end">
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

export function Bugs() {
  const features = useFeatureFlags();
  const [searchTxt, setSearchTxt] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [createOpened, setCreateOpened] = useState(false);
  const [editingItem, setEditingItem] = useState<Bug | undefined>();
  const [lastSeenBug, setLastSeenBug] = useLocalStorage<number>({
    key: 'last-seen-bug',
    defaultValue: 0,
    getInitialValueInEffect: false,
  });
  const ref = useRef<HTMLDivElement>(null);
  const lastSeenRef = useRef<number>(lastSeenBug);

  const filters = useMemo(
    () =>
      removeEmpty(
        {
          search: searchTxt.length > 0 ? searchTxt : undefined,
          sortDir,
          includeClosed,
        },
        true
      ),
    [searchTxt, sortDir, includeClosed]
  );
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 400);

  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isRefetching } =
    trpc.bug.getInfinite.useInfiniteQuery(
      { ...debouncedFilters },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  const canEdit = features.bugsEdit;
  // Capped to the endpoint's max; Known Issues lists are small so this only guards against runaway scroll.
  const bugIds = useMemo(() => (flatData ?? []).slice(0, 200).map((b) => b.id), [flatData]);
  const { data: reportStats } = trpc.bug.getReportStats.useQuery(
    { bugIds },
    { enabled: canEdit && bugIds.length > 0, placeholderData: keepPreviousData, staleTime: 60_000 }
  );

  useEffect(() => {
    if (!flatData?.length) return;
    const latest = Math.max(...flatData.map((item) => new Date(item.updatedAt).getTime()));
    if (latest > lastSeenBug) setLastSeenBug(latest);
  }, [flatData, lastSeenBug, setLastSeenBug]);

  const isAsc = sortDir === 'asc';

  return (
    <Stack ref={ref}>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Group gap="sm" wrap="nowrap" className="w-full sm:w-auto">
          <Text fz={26} fw="bold">
            Known Issues
          </Text>
          {canEdit && (
            <Button
              size="compact-sm"
              leftSection={createOpened ? <IconMinus size={14} /> : <IconPlus size={14} />}
              onClick={() => {
                if (createOpened) setEditingItem(undefined);
                setCreateOpened((o) => !o);
              }}
            >
              {createOpened ? 'Hide' : editingItem ? 'Update' : 'Create New'}
            </Button>
          )}
        </Group>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          <TextInputWrapper
            value={searchTxt}
            onChange={(event) => setSearchTxt(event.currentTarget.value)}
            placeholder="Search bugs..."
            className="w-full sm:mr-2 sm:w-[300px]"
          />

          <Switch
            label="Show closed"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.currentTarget.checked)}
          />

          <div className="flex w-full flex-row justify-end gap-2 sm:w-auto">
            <Button
              variant="light"
              className="rounded-3xl"
              size="sm"
              p="sm"
              onClick={() => setSortDir(isAsc ? 'desc' : 'asc')}
            >
              {isAsc ? <IconSortAscending size={18} /> : <IconSortDescending size={18} />}
            </Button>
          </div>
        </div>
      </div>

      {canEdit && (
        <CreateBug
          key={editingItem ? `edit-${editingItem.id}` : 'create-new'}
          opened={createOpened}
          setOpened={setCreateOpened}
          existing={editingItem}
          setEditingItem={setEditingItem}
        />
      )}

      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : isError ? (
        <Center p="xl">
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching the bug data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !!flatData?.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <Stack gap="xl">
            {flatData.map((b) => (
              <BugItem
                key={b.id}
                item={b}
                canEdit={canEdit}
                setEditingItem={setEditingItem}
                setOpened={setCreateOpened}
                scrollRef={ref}
                lastSeen={lastSeenRef.current}
                reportPoints={reportStats?.[b.id]}
              />
            ))}
          </Stack>

          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && (searchTxt || includeClosed) && <EndOfFeed text="That's all" />}
        </div>
      ) : searchTxt ? (
        <NoContent my="lg" />
      ) : (
        <Paper withBorder p="xl" radius="md" className="text-center">
          <Stack gap="sm" align="center">
            <IconCircleCheck size={48} className="text-green-6" />
            <Text fz={22} fw={700}>
              All clear
            </Text>
            <Text c="dimmed" maw={420}>
              No known issues right now. Everything we&apos;re aware of is working as expected. If
              something looks broken, hit the Support button below to let us know.
            </Text>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
