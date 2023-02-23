import { Card } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { useS3UploadStore } from '~/store/s3-upload.store';

const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
  Model: '.ckpt,.pt,.safetensors,.bin',
  'Pruned Model': '.ckpt,.pt,.safetensors',
  Negative: '.pt,.bin',
  'Training Data': '.zip',
  Config: '.yaml,.yml',
  VAE: '.pt,.ckpt,.safetensors',
  'Text Encoder': '.pt',
};

const fileTypesByModelType: Record<ModelType, ModelFileType[]> = {
  TextualInversion: ['Model', 'Negative', 'Training Data'],
  LORA: ['Model', 'Text Encoder', 'Training Data'],
  Checkpoint: ['Model', 'Pruned Model', 'Config', 'VAE', 'Training Data'],
  AestheticGradient: ['Model', 'Training Data'],
  Hypernetwork: ['Model', 'Training Data'],
};

/*
TODO.posts
  - list files
  - add new files
  - update context/store with upload results
  - trpc.modelfiles.create on upload complete
*/

export function Files({ modelVersionId }: FilesProps) {
  const { items, clear, upload, abort } = useS3UploadStore();

  return (
    <>
      {/* TODO.dropzone */}
      {/* TODO.list */}
      <Card>
        {/* TODO.file progress */}
        {/* TODO.file type select */}
      </Card>
    </>
  );
}

type FilesProps = {
  modelVersionId: number;
};

// export function Files({ modelVersionId }: FilesProps) {
//   const { items, reset, upload, abort } = useS3UploadStore();

//   const { mutate } = trpc.modelFile.create.useMutation({
//     onSuccess: () => {
//       // update/invalidate cache
//     },
//   });

//   const handleDropFile = (file: File) => {
//     upload({ file, type: UploadType.Model, meta: { modelVersionId } }, ({ url, bucket, key }) => {
//       mutate({
//         sizeKB: file.size ? bytesToKB(file.size) : 0,
//         type: 'Model',
//         url,
//         name: file.name,
//         modelVersionId,
//       });
//     });
//   };

//   return (
//     <>
//       {items
//         .filter((x) => x.meta.modelVersionId === modelVersionId)
//         .map((item) => {
//           const { modelVersionId } = item.meta as { modelVersionId?: number };
//           return <>Model version details and progress</>;
//         })}
//     </>
//   );
// }
