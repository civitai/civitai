import { Anchor, Badge, Button, Chip, JsonInput, Modal, Paper, Stack, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import type {
  MRT_ColumnDef,
  MRT_PaginationState,
  MRT_SortingState,
  MRT_TableInstance,
} from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import type * as z from 'zod';
import { Collection } from '~/components/Collection/Collection';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Form, InputCheckbox, InputRTE, InputText, useForm } from '~/libs/form';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export function FlaggedModelsList() {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const page = isNumber(router.query.page) ? Number(router.query.page) : 1;
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: page - 1,
    pageSize: 20,
  });
  const [sorting, setSorting] = useState<MRT_SortingState>([{ id: 'createdAt', desc: true }]);

  const { data, isLoading, isFetching, isRefetching } = trpc.moderator.models.queryFlagged.useQuery(
    { page: pagination.pageIndex + 1, limit: pagination.pageSize, sort: sorting }
  );
  const flaggedModels = data?.items ?? [];

  const resolveFlaggedModelMutation = trpc.moderator.models.resolveFlagged.useMutation({
    onSuccess: async () => {
      await queryUtils.moderator.models.queryFlagged.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error resolving flagged model',
        error: new Error(error.message),
      });
    },
  });
  const handleResolveSelectedModels = async (
    mrtInstance: MRT_TableInstance<(typeof flaggedModels)[number]>
  ) => {
    const selectedRows = mrtInstance.getSelectedRowModel().rows.map((row) => row.original.modelId);
    try {
      await resolveFlaggedModelMutation.mutateAsync({ ids: selectedRows });
      mrtInstance.resetRowSelection(true);
    } catch {
      // Error is handled in the mutation
    }
  };

  const columns = useMemo<MRT_ColumnDef<(typeof flaggedModels)[number]>[]>(
    () => [
      {
        id: 'modelId',
        header: 'Model',
        accessorKey: 'model.name',
        enableColumnActions: false,
        enableSorting: false,
        Cell: ({ row: { original } }) => (
          <Link href={`/models/${original.modelId}?view=basic`} passHref legacyBehavior>
            <Anchor target="_blank">
              <div className="flex flex-nowrap gap-1">
                <IconExternalLink className="shrink-0 grow-0" size={16} />
                <Text span inline>
                  {original.model.name}
                </Text>
              </div>
            </Anchor>
          </Link>
        ),
      },
      {
        header: 'Review',
        accessorFn: (row) => row.model.id,
        enableColumnActions: false,
        enableSorting: false,
        Cell: ({ row: { original } }) => {
          const items = Object.entries(original)
            .filter(
              ([key, value]) =>
                ['poi', 'nsfw', 'minor', 'sfwOnly', 'triggerWords', 'poiName'].includes(key) &&
                !!value
            )
            .map(([key, value]) => ({ name: key, value }));

          return (
            <Collection
              items={items}
              renderItem={(item) => <Badge color="yellow">{item.name}</Badge>}
              grouped
            />
          );
        },
      },
      // These are here just to comply with MRT sorting
      { accessorKey: 'createdAt', header: 'createdAt', Cell: () => null },
      { accessorKey: 'poi', header: 'poi', Cell: () => null },
      { accessorKey: 'nsfw', header: 'nsfw', Cell: () => null },
      {
        header: 'Action',
        accessorKey: 'model.id',
        size: 100,
        enableColumnActions: false,
        enableSorting: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => (
          <Button
            onClick={() =>
              dialogStore.trigger({
                component: DetailsModal,
                props: { model: original.model, details: original.details },
              })
            }
            size="compact-sm"
          >
            Resolve
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <MantineReactTable
      columns={columns}
      data={flaggedModels}
      rowCount={data?.totalItems ?? 0}
      maxMultiSortColCount={2}
      onPaginationChange={setPagination}
      onSortingChange={setSorting}
      enableStickyHeader
      enableSortingRemoval
      enableMultiRowSelection
      enableRowSelection
      manualPagination
      enableHiding={false}
      enableGlobalFilter={false}
      enableColumnFilters={false}
      mantineTableProps={{
        style: { tableLayout: 'fixed' },
      }}
      mantineTableContainerProps={{ style: { maxHeight: 450 } }}
      initialState={{
        density: 'xs',
        // Hiding these columns because they're irrelevant
        columnVisibility: {
          createdAt: false,
          poi: false,
          nsfw: false,
        },
      }}
      state={{
        isLoading: isLoading || isRefetching,
        showProgressBars: isFetching,
        sorting,
        pagination,
      }}
      renderToolbarInternalActions={({ table }) =>
        table.getSelectedRowModel().rows.length > 0 ? (
          <Button
            ml="auto"
            onClick={() => handleResolveSelectedModels(table)}
            loading={resolveFlaggedModelMutation.isLoading}
            size="compact-sm"
          >
            Resolve Selected
          </Button>
        ) : undefined
      }
      renderTopToolbarCustomActions={({ table }) => (
        <div className="flex items-center gap-2">
          <Text span inline>
            Sort By:{' '}
          </Text>
          <Chip
            size="xs"
            variant="filled"
            onChange={(value) =>
              value
                ? setSorting([
                    { id: 'poi', desc: true },
                    { id: 'nsfw', desc: true },
                  ])
                : table.resetSorting(true)
            }
          >
            <span>High Priority</span>
          </Chip>
        </div>
      )}
    />
  );
}

const schema = modelUpsertSchema.pick({
  id: true,
  name: true,
  description: true,
  poi: true,
  nsfw: true,
  minor: true,
  type: true,
  uploadType: true,
  status: true,
  sfwOnly: true,
});

function DetailsModal({ model, details }: { model: z.infer<typeof schema>; details: MixedObject }) {
  const context = useDialogContext();
  const queryUtils = trpc.useUtils();
  const form = useForm({
    schema,
    defaultValues: { ...model, sfwOnly: model.poi || model.minor || model.sfwOnly },
    shouldUnregister: false,
  });
  const isDirty = form.formState.isDirty;

  const upsertModelMutation = trpc.model.upsert.useMutation({
    onSuccess: async (result) => {
      await queryUtils.model.getById.invalidate({ id: result.id });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error saving model',
        error: new Error(error.message),
      });
    },
  });

  const resolveFlaggedModelMutation = trpc.moderator.models.resolveFlagged.useMutation({
    onSuccess: async () => {
      await queryUtils.moderator.models.queryFlagged.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error resolving flagged model',
        error: new Error(error.message),
      });
    },
  });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    if (!data.id) return;

    try {
      if (isDirty) await upsertModelMutation.mutateAsync(data);
      await resolveFlaggedModelMutation.mutateAsync({ ids: [data.id] });

      context.onClose();
    } catch {
      // Error is handled in the mutation
    }
  };

  const [poi, nsfw, minor] = form.watch(['poi', 'nsfw', 'minor']);

  return (
    <Modal {...context} title="Resolve Model" size="75%" centered>
      <div className="flex flex-nowrap gap-8">
        <Form className="flex-1" form={form} onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4">
            <InputText name="name" label="Name" placeholder="Name" withAsterisk />

            <InputRTE
              name="description"
              label="Description"
              description="Tell us what your model does"
              includeControls={[
                'heading',
                'formatting',
                'list',
                'link',
                'media',
                'mentions',
                'colors',
              ]}
              editorSize="xl"
              placeholder="What does your model do? What's it for? What is your model good at? What should it be used for? What is your resource bad at? How should it not be used?"
              withAsterisk
            />
            <Paper radius="md" p="xl" withBorder>
              <Stack gap="xs">
                <Text size="md" fw={500}>
                  This resource:
                </Text>
                <InputCheckbox
                  name="poi"
                  label="Depicts an actual person (Resource cannot be used on Civitai on-site Generator)"
                  onChange={(e) => {
                    form.setValue('nsfw', e.target.checked ? false : undefined);
                    if (e.target.checked) {
                      form.setValue('sfwOnly', true);
                    }
                  }}
                />
                <InputCheckbox
                  name="nsfw"
                  label="Is intended to produce mature themes"
                  disabled={poi}
                  onChange={(event) => {
                    if (event.target.checked) {
                      form.setValue('minor', false);
                      form.setValue('sfwOnly', false);
                    }
                  }}
                />
                <InputCheckbox
                  name="sfwOnly"
                  label="Cannot be used for NSFW generation"
                  disabled={nsfw || poi || minor}
                />
                <InputCheckbox
                  name="minor"
                  label="Depicts a minor"
                  onChange={(e) => (e.target.checked ? form.setValue('sfwOnly', true) : undefined)}
                  disabled={nsfw}
                />
              </Stack>
            </Paper>
            <Button
              type="submit"
              loading={resolveFlaggedModelMutation.isLoading || upsertModelMutation.isLoading}
            >
              Save & Resolve
            </Button>
          </div>
        </Form>

        <div className="w-64 flex-none">
          <Text size="md" fw={600} className="mb-2">
            Scan Details
          </Text>
          <JsonInput value={JSON.stringify(details, null, 2)} minRows={4} formatOnBlur autosize />
        </div>
      </div>
    </Modal>
  );
}
