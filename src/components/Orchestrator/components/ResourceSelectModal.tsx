import { Modal } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import { useMemo } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { BaseModel } from '~/server/common/constants';
import { GenerationResource } from '~/server/services/generation/generation.service';

export function ResourceSelectModal({
  title,
  onAdd,
  baseModel,
  modelTypes,
  canGenerate,
}: {
  title: React.ReactNode;
  onAdd: (resource: GenerationResource) => void;
  baseModel?: BaseModel;
  modelTypes?: ModelType[];
  canGenerate?: boolean;
}) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();

  const filters = useMemo(() => {
    const arr: string[] = [];
    if (canGenerate !== undefined) arr.push(`canGenerate = ${canGenerate}`);
    // if(baseModel) arr.push()
  }, []);

  return <Modal {...dialog} title={title} size={1200}></Modal>;
}
