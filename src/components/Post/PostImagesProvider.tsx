import { createContext, useContext, useEffect, useState } from 'react';
import { PostDetail } from '~/server/controllers/post.controller';
import { useCFUploadStore } from '~/store/cf-upload.store';
import { v4 as uuidv4 } from 'uuid';
import { loadImage, blurHashImage } from '~/utils/blurhash';
import { auditMetaData, getMetadata } from '~/utils/image-metadata';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { AddPostImageInput, PostUpdateInput } from '~/server/schema/post.schema';
import { useRouter } from 'next/router';
import { showErrorNotification } from '~/utils/notifications';

type ImageModel = PostDetail['images'][0];

type UploadMeta = {
  uuid: string;
  url: string;
  name: string;
  meta: any;
  height: number;
  width: number;
  hash: string;
  index: number;
  blockedFor?: string;
};
type UploadModel = UploadMeta & {
  file: File;
};
type ImageType = { type: 'image' } & ImageModel;
type UploadType = { type: 'upload' } & UploadModel;
type ImageState = ImageType | UploadType;

type PostImagesState = {
  items: ImageState[];
  upload: (postId: number, files: File[]) => Promise<void>;
  reorder: (postId: number, imageIds: number[]) => Promise<void>;
};

const PostImagesCtx = createContext<PostImagesState | null>(null);
export const usePostImagesContext = () => {
  const context = useContext(PostImagesCtx);
  if (!context) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');
  return context;
};

export const PostImagesProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const postId = router.query.postId ? Number(router.query.postId) : 0;
  const upload = useCFUploadStore((state) => state.upload);
  const clear = useCFUploadStore((state) => state.clear);

  const [items, setItems] = useState<ImageState[]>([]);

  // #region [queries]
  const queryUtils = trpc.useContext();
  const { data, isLoading } = trpc.post.get.useQuery({ id: postId }, { enabled: postId > 0 });
  // #endregion

  // #region [mutations]
  const { mutateAsync: addImageAsync } = trpc.post.addImage.useMutation();
  const { mutateAsync: reorderImagesAsync } = trpc.post.reorderImages.useMutation();
  const { mutateAsync: updatePostAsync } = trpc.post.update.useMutation();
  // #endregion

  // set initial data
  useEffect(() => {
    if (data && !items.length) {
      setItems(data.images.map((image) => ({ type: 'image', ...image })));
    }
  }, [data, items]);

  // #region [helpers]
  const updateCachedPost = (fn: (old: PostDetail) => PostDetail) => {
    queryUtils.post.get.setData({ id: postId }, (old) => {
      if (!old) return old;
      return fn(old);
    });
    // TODO.posts - invalidate other post caches
  };
  // #endregion

  const handleUpload = async (postId: number, files: File[]) => {
    const toUpload = await Promise.all(
      files.map(async (file, i) => {
        const index = items.length + i;
        const name = file.name;
        const url = URL.createObjectURL(file);
        const meta = await getMetadata(file); // TODO - get resources
        const img = await loadImage(url);
        const hashResult = blurHashImage(img);
        const auditResult = await auditMetaData(meta, false);
        const blockedFor = !auditResult?.success ? auditResult?.blockedFor : undefined;

        return {
          type: 'upload',
          file,
          uuid: uuidv4(),
          name,
          meta,
          url,
          ...hashResult,
          index,
        } as UploadType;
      })
    );
    setItems((state) => [...state, ...toUpload]);

    await Promise.all(
      toUpload.map(async (data) => {
        const { type, file, ...meta } = data;
        await upload<UploadMeta>({ file, meta }, async ({ url, id, meta, uuid }) => {
          const toCreate: AddPostImageInput = {
            ...meta,
            url: id,
            postId,
          };
          try {
            const image = await addImageAsync(toCreate);
            clear((item) => item.uuid === uuid);
            setItems(
              produce((state) => {
                const index = state.findIndex((x) => x.type === 'upload' && x.uuid === meta.uuid);
                if (index === -1) throw new Error('index out of bounds');
                state[index] = { type: 'image', ...image };
              })
            );
          } catch (error: any) {
            showErrorNotification({ error, reason: 'There was a problem uploading your image' });
          }
        });
      })
    );

    updateCachedPost((old) => ({
      ...old,
      images: items
        .filter((x) => x.type === 'image')
        .map(({ type, ...image }) => image) as ImageModel[],
    }));
  };

  const handleReorderImages = async (postId: number, imageIds: number[]) => {
    await reorderImagesAsync(
      { id: postId, imageIds },
      {
        onSuccess: (response) => {
          // const sorted = items.filter(x => x.type === 'image').sort((a,b) => {
          //   return imageIds.indexOf(a.id)
          // })
          updateCachedPost((old) => ({ ...old, images: response }));
        },
      }
    );
  };

  const handleUpdatePost = async (data: PostUpdateInput) => {
    await updatePostAsync(data, {
      onSuccess: () => {
        const keys = Object.keys(data) as Array<keyof PostUpdateInput>;
        // reducer to remove empty keys
        const toUpdate = keys.reduce((acc, key) => {
          if (data[key]) acc[key] = data[key];
          return acc;
        }, {} as any) as PostUpdateInput;
        updateCachedPost((old) => ({ ...old, ...toUpdate }));
      },
    });
  };

  return (
    <PostImagesCtx.Provider
      value={{
        items,
        upload: handleUpload,
        reorder: handleReorderImages,
      }}
    >
      {children}
    </PostImagesCtx.Provider>
  );
};
