import { ActionIcon, createStyles, Stack, Stepper } from '@mantine/core';
import { IconX } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { Files } from '~/components/Resource/Files';

import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { Wizard } from '~/components/Resource/Wizard/Wizard';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  closeButton: {
    position: 'absolute',
    top: theme.spacing.xl,
    right: theme.spacing.xl,
  },
}));

/**
 * TODO.posts: change routes when saving the model and version
 * TODO.posts: invalidate queries to sync data with server
 * TODO.posts: add a loading state
 * TODO.posts: add a success state
 * TODO.posts: colocate prev/next buttons with the stepper
 */
export function ModelWizard() {
  const { classes } = useStyles();
  const [state, setState] = useState<{
    model?: ModelUpsertInput;
    modelVersion?: ModelVersionUpsertInput;
  }>({});

  const router = useRouter();
  const { pathname } = router;
  const { modelId } = router.query;
  const isNew = pathname.includes('new');
  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery(
    { id: Number(modelId) },
    { enabled: !isNew && !!modelId }
  );
  const { data: versions, isLoading: loadingVersions } = trpc.model.getVersions.useQuery(
    { id: model?.id ?? -1 },
    { enabled: !isNew && !!model }
  );

  const [firstVersion] = versions ?? [];

  return (
    <>
      <ActionIcon className={classes.closeButton} onClick={() => router.back()}>
        <IconX />
      </ActionIcon>
      <Stack py={60}>
        <Wizard>
          <Stepper.Step label="Create your model">
            <ModelUpsertForm
              model={state.model}
              onSubmit={(model) => {
                setState((current) => ({ ...current, model }));
              }}
            />
          </Stepper.Step>
          <Stepper.Step label="Add version">
            <ModelVersionUpsertForm
              model={state.model}
              version={state.modelVersion}
              onSubmit={(modelVersion) => setState((current) => ({ ...current, modelVersion }))}
            />
          </Stepper.Step>
          <Stepper.Step label="Upload files">
            <Files model={state.model} version={state.modelVersion} />
          </Stepper.Step>

          <Stepper.Completed>
            Completed, click back button to get to previous step
          </Stepper.Completed>
        </Wizard>
      </Stack>
    </>
  );
}
