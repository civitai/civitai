import { Anchor, Badge, Button, JsonInput, Modal, Paper, Stack, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { MantineReactTable, MRT_ColumnDef, MRT_PaginationState } from 'mantine-react-table';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Form, InputCheckbox, InputRTE, InputText, useForm } from '~/libs/form';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export function FlaggedModelsList() {
  const router = useRouter();
  const page = isNumber(router.query.page) ? Number(router.query.page) : 1;
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: page - 1,
    pageSize: 20,
  });

  const { data, isLoading, isFetching, isRefetching } = trpc.moderator.models.queryFlagged.useQuery(
    { page: pagination.pageIndex + 1, limit: pagination.pageSize }
  );
  const flaggedModels = data?.items ?? [];

  const columns = useMemo<MRT_ColumnDef<(typeof flaggedModels)[number]>[]>(
    () => [
      {
        id: 'modelId',
        header: 'Model',
        accessorKey: 'model.name',
        enableColumnActions: false,
        Cell: ({ row: { original } }) => (
          <Link href={`/models/${original.modelId}?view=basic`} passHref>
            <Anchor target="_blank" inline>
              <div className="flex flex-nowrap gap-1">
                <IconExternalLink className="shrink-0 grow-0" size={16} />
                <Text>{original.model.name}</Text>
              </div>
            </Anchor>
          </Link>
        ),
      },
      {
        header: 'POI',
        accessorKey: 'poi',
        size: 150,
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.poi} />,
      },
      {
        header: 'NSFW',
        accessorKey: 'nsfw',
        size: 150,
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.nsfw} />,
      },
      {
        header: 'Trigger Words',
        accessorKey: 'triggerWords',
        size: 150,
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.triggerWords} />,
      },
      {
        header: 'Action',
        accessorKey: 'model.id',
        size: 100,
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => (
          <Button
            size="sm"
            onClick={() =>
              dialogStore.trigger({
                component: DetailsModal,
                props: { model: original.model, details: original.details },
              })
            }
            compact
          >
            Resolve
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <div>
      <MantineReactTable
        columns={columns}
        data={flaggedModels}
        rowCount={data?.totalItems ?? 0}
        enableSorting={false}
        enableFilters={false}
        enableHiding={false}
        enableMultiSort={false}
        enableGlobalFilter={false}
        onPaginationChange={setPagination}
        enableStickyHeader
        enablePinning
        manualPagination
        mantineTableProps={{
          sx: { tableLayout: 'fixed' },
        }}
        mantineTableContainerProps={{ sx: { maxHeight: 450 } }}
        initialState={{ density: 'xs', columnPinning: { left: ['model.name'] } }}
        state={{
          isLoading: isLoading || isRefetching,
          showProgressBars: isFetching,
          pagination,
        }}
      />
    </div>
  );
}

function FlagCell({ value }: { value: boolean }) {
  return value ? (
    <Badge color="yellow" size="sm">
      Needs Attention
    </Badge>
  ) : (
    <Badge color="green" size="sm">
      Clear
    </Badge>
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
});

function DetailsModal({ model, details }: { model: z.infer<typeof schema>; details: MixedObject }) {
  const context = useDialogContext();
  const queryUtils = trpc.useUtils();
  const form = useForm({ schema, defaultValues: { ...model }, shouldUnregister: false });
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

      await resolveFlaggedModelMutation.mutateAsync({ id: data.id });

      context.onClose();
    } catch {
      // Error is handled in the mutation
    }
  };

  const [poi, nsfw] = form.watch(['poi', 'nsfw']);

  return (
    <Modal {...context} title="Resolve Model" size="75%" centered>
      <div className="flex flex-nowrap gap-8">
        <Form form={form} onSubmit={handleSubmit}>
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
              <Stack spacing="xs">
                <Text size="md" weight={500}>
                  This resource:
                </Text>
                <InputCheckbox
                  name="poi"
                  label="Depicts an actual person (Resource cannot be used on Civitai on-site Generator)"
                  onChange={(e) => {
                    form.setValue('nsfw', e.target.checked ? false : undefined);
                  }}
                />
                <InputCheckbox
                  name="nsfw"
                  label="Is intended to produce mature themes"
                  disabled={poi}
                  onChange={(event) =>
                    event.target.checked ? form.setValue('minor', false) : null
                  }
                />
                <InputCheckbox
                  name="minor"
                  label="Cannot be used for NSFW generation"
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
          <Text size="md" weight={600} className="mb-2">
            Scan Details
          </Text>
          <JsonInput value={JSON.stringify(details, null, 2)} minRows={4} formatOnBlur autosize />
        </div>
      </div>
    </Modal>
  );
}
