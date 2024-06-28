import { Modal } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { BaseModel } from '~/server/common/constants';
import { GenerationResource } from '~/shared/constants/generation.constants';

export function ResourceSelectModal({
  title,
  onAdd,
  baseModel,
  modelTypes,
  canGenerate,
}: {
  title: React.ReactNode;
  onAdd: (resource: GenerationResource) => void;
  baseModel: BaseModel;
  modelTypes: ModelType[];
  canGenerate?: boolean;
}) {
  const dialog = useDialogContext();

  return <Modal {...dialog} title={title} size={1200}></Modal>;
}
