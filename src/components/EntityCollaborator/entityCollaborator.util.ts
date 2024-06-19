import {
  GetEntityCollaboratorsInput,
  UpsertEntityCollaboratorInput,
} from '~/server/schema/entity-collaborator.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useGetEntityCollaborators = ({
  entityId,
  entityType,
}: GetEntityCollaboratorsInput) => {
  const { data: collaborators = [], ...rest } = trpc.entityCollaborator.get.useQuery({
    entityId,
    entityType,
  });

  return {
    collaborators,
    ...rest,
  };
};

export const useEntityCollaboratorsMutate = () => {
  const queryUtils = trpc.useUtils();

  const onError = (error: any, message = 'There was an error while performing your request') => {
    try {
      // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
      const parsedError = JSON.parse(error.message);
      showErrorNotification({
        title: message,
        error: parsedError,
      });
    } catch (e) {
      // Report old error as is:
      showErrorNotification({
        title: message,
        error: new Error(error.message),
      });
    }
  };

  const upsertEntityCollaboratorMutation = trpc.entityCollaborator.upsert.useMutation({
    onSuccess(_, input) {
      queryUtils.entityCollaborator.get.invalidate({
        entityId: input.entityId,
        entityType: input.entityType,
      });
    },
    onError(error) {
      onError(error, 'Failed to update or create collaborator.');
    },
  });

  const handleUpsertEntityCollaborator = (input: UpsertEntityCollaboratorInput) => {
    return upsertEntityCollaboratorMutation.mutateAsync(input);
  };

  return {
    upsertEntityCollaborator: handleUpsertEntityCollaborator,
    upsertingEntityCollaborator: upsertEntityCollaboratorMutation.isLoading,
  };
};
