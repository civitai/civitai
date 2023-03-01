import { createContext, useContext } from 'react';
import { MIME_TYPES } from '@mantine/dropzone';
import { PostDetail } from '~/server/controllers/post.controller';
import { useCFUploadStore } from '~/store/cf-upload.store';
import { v4 as uuidv4 } from 'uuid';
import { loadImage, blurHashImage } from '~/utils/blurhash';
import { getMetadata } from '~/utils/image-metadata';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { AddPostImageInput } from '~/server/schema/post.schema';
import { useListState, UseListStateHandlers } from '@mantine/hooks';

// const IMAGE_MIME_TYPES = [MIME_TYPES.jpeg, MIME_TYPES.png] as string[];
// const VIDEO_MIME_TYPES = [MIME_TYPES.mp4, MIME_TYPES.gif] as string[];

type ImageModel = PostDetail['images'][0];

type UploadMeta = {
  uuid: string;
  name: string;
  meta: any;
  height: number;
  width: number;
  hash: string;
  index: number;
};
type UploadModel = UploadMeta & {
  file: File;
};
type ImageType = { type: 'image' } & ImageModel;
type UploadType = { type: 'upload' } & UploadModel;
type ImageState = ImageType | UploadType;

type PostImagesState = {
  items: ImageState[];
  upload: (postId: number, files: File[]) => void;
  handlers: UseListStateHandlers<ImageState>;
};

const PostImagesCtx = createContext<PostImagesState | null>(null);
export const usePostImagesContext = () => {
  const context = useContext(PostImagesCtx);
  if (!context) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');
  return context;
};

export const PostImagesProvider = ({ children }: { children: React.ReactNode }) => {
  const [items, handlers] = useListState<ImageState>([]);
  const upload = useCFUploadStore((state) => state.upload);
  const clear = useCFUploadStore((state) => state.clear);
  const { mutate } = trpc.post.addImage.useMutation();
  const queryUtils = trpc.useContext();

  // // if state.length > 0, then we must already have either received initial data or begun processing files
  // const handleSetInitialData = (data: ImageModel[]) => {
  //   handlers.setState((state) => {
  //     if (state.length > 0) return state;
  //     return data.map((image) => ({ type: 'image', ...image }));
  //   });
  // };

  const handleUpload = async (postId: number, files: File[]) => {
    const toUpload = await Promise.all(
      files.map(async (file, i) => {
        const index = items.length + i;
        const name = file.name;
        const url = URL.createObjectURL(file);
        const meta = await getMetadata(file); // TODO - get resources
        const img = await loadImage(url);
        const hashResult = blurHashImage(img);
        URL.revokeObjectURL(url);
        return {
          type: 'upload',
          file,
          // add the uuid and pass it to upload metadata to be able to find the correct state index based on the upload result
          uuid: uuidv4(),
          name,
          meta,
          ...hashResult,
          index,
        } as UploadType;
      })
    );
    handlers.setState((state) => [...state, ...toUpload]);

    for (const data of toUpload) {
      const { type, file, ...meta } = data;
      upload<UploadMeta>({ file, meta }, ({ url, id, meta, uuid }) => {
        const toCreate: AddPostImageInput = {
          url: id,
          postId,
          ...meta,
        };
        mutate(toCreate, {
          onSuccess: async (response) => {
            clear((item) => item.uuid === uuid);
            handlers.setState(
              produce((state) => {
                const index = state.findIndex((x) => x.type === 'upload' && x.uuid === meta.uuid);
                if (index === -1) throw new Error('index out of bounds');
                state[index] = { type: 'image', ...response };
              })
            );
            queryUtils.post.get.setData(
              { id: postId },
              produce((old) => {
                if (!old) return;
                old.images = old.images.concat(response);
              })
            );
          },
        });
      });
    }
  };

  return (
    <PostImagesCtx.Provider
      value={{
        items,
        upload: handleUpload,
        handlers,
      }}
    >
      {children}
    </PostImagesCtx.Provider>
  );
};
