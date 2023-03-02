import { createStore, useStore } from 'zustand';
import { createContext, useContext, useRef, useEffect } from 'react';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';
import { PostDetail } from '~/server/controllers/post.controller';
import { SimpleTag } from '~/server/selectors/tag.selector';
import { PostImage } from '~/server/selectors/post.selector';
import { devtools } from 'zustand/middleware';
import { loadImage, blurHashImage } from '~/utils/blurhash';
import { getMetadata, auditMetaData } from '~/utils/image-metadata';
import { isDefined } from '~/utils/type-guards';
import Router from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCFUploadStore } from '~/store/cf-upload.store';

//https://github.com/pmndrs/zustand/blob/main/docs/guides/initialize-state-with-props.md
export type ImageUpload = {
  uuid: string;
  url: string;
  name: string;
  meta: any;
  resources?: string[];
  height: number;
  width: number;
  hash: string;
  index: number;
  status: 'aborted' | 'uploading';
  message?: string;
  file: File;
};
type ImageProps = { type: 'image'; data: PostImage } | { type: 'upload'; data: ImageUpload };

type EditPostProps = {
  // objectUrls: string[];
  id: number;
  title?: string;
  nsfw: boolean;
  tags: SimpleTag[];
  images: ImageProps[];
};

interface EditPostState extends EditPostProps {
  setTitle: (title?: string) => void;
  toggleNsfw: (value?: boolean) => void;
  setTags: (updateFn: (tags: SimpleTag[]) => SimpleTag[]) => void;
  setImages: (updateFn: (images: PostImage[]) => PostImage[]) => void;
  upload: (postId: number, files: File[]) => void;
  // addFiles: (files: File[]) => Promise<ImageUpload[]>;
  /** usefull for removing files that were unable to finish uploading */
  removeFile: (uuid: string) => void;
  /** used to clean up object urls */
  // cleanup: () => void;
}

type EditPostStore = ReturnType<typeof createEditPostStore>;

const prepareImages = (images: PostImage[]) =>
  images.map((image): ImageProps => ({ type: 'image', data: image }));

const processPost = (post?: PostDetail) => {
  return {
    id: post?.id ?? 0,
    title: post?.title ?? undefined,
    nsfw: post?.nsfw ?? false,
    tags: post?.tags ?? [],
    images: post?.images ? prepareImages(post.images) : [],
  };
};

const createEditPostStore = ({
  post,
  handleUpload,
}: {
  post?: PostDetail;
  handleUpload: (postId: number, toUpload: ImageUpload) => Promise<PostImage>;
}) => {
  return createStore<EditPostState>()(
    devtools(
      immer((set, get) => {
        const initialData = processPost(post);
        return {
          objectUrls: [],
          ...initialData,
          // methods
          setTitle: (title) => {
            set((state) => {
              state.title = title;
            });
          },
          toggleNsfw: (value) => {
            set((state) => {
              state.nsfw = value ?? !state.nsfw;
            });
          },
          setTags: (updateFn) => {
            set((state) => {
              state.tags = updateFn(state.tags);
            });
          },
          setImages: (updateFn) => {
            set((state) => {
              // only allow calling setImages if uploads are finished
              if (state.images.every((x) => x.type === 'image')) {
                const images = state.images.map(({ data }) => data as PostImage);
                state.images = prepareImages(updateFn(images));
              }
            });
          },
          upload: async (postId, files) => {
            set((state) => {
              state.id = postId;
            });
            const images = get().images;
            const toUpload = await Promise.all(
              files.map(async (file, i) => {
                const data = await getImageDataFromFile(file);
                return {
                  type: 'upload',
                  index: images.length + i,
                  ...data,
                } as ImageUpload;
              })
            );
            set((state) => {
              // state.objectUrls = toUpload.map((x) => x.url);
              state.images = state.images.concat(
                toUpload.map((data) => ({ type: 'upload', data }))
              );
            });
            await Promise.all(
              toUpload
                // do not upload images that have been rejected due to image prompt keywords
                .filter((x) => x.status === 'uploading')
                .map(async (data) => {
                  const result = await handleUpload(postId, data);
                  set((state) => {
                    const index = state.images.findIndex(
                      (x) => x.type === 'upload' && x.data.uuid === data.uuid
                    );
                    if (index === -1) throw new Error('index out of bounds');
                    state.images[index] = { type: 'image', data: result };
                  });
                  URL.revokeObjectURL(data.url);
                })
            );
          },
          // addFiles: async (files) => {
          //   const images = get().images;
          //   const toUpload = await Promise.all(
          //     files.map(async (file, i) => {
          //       const data = await getImageDataFromFile(file);
          //       return {
          //         type: 'upload',
          //         index: images.length + i,
          //         ...data,
          //       } as ImageUpload;
          //     })
          //   );
          //   set((state) => {
          //     state.objectUrls = toUpload.map((x) => x.url);
          //     state.images = state.images.concat(
          //       toUpload.map((data) => ({ type: 'upload', data }))
          //     );
          //   });
          //   return toUpload;
          // },
          removeFile: (uuid) => {
            set((state) => {
              const index = state.images.findIndex(
                (x) => x.type === 'upload' && x.data.uuid === uuid
              );
              if (index === -1) throw new Error('index out of bounds');
              state.images.splice(index, 1);
            });
          },
          // cleanup: () => {
          //   const objectUrls = get().objectUrls;
          //   for (const url of objectUrls) {
          //     URL.revokeObjectURL(url);
          //   }
          // },
        };
      })
    )
  );
};

export const EditPostContext = createContext<EditPostStore | null>(null);
export const EditPostProvider = ({
  children,
  post,
}: {
  children: React.ReactNode;
  post?: PostDetail;
}) => {
  const queryUtils = trpc.useContext();
  const { mutateAsync } = trpc.post.addImage.useMutation();

  const upload = useCFUploadStore((state) => state.upload);
  const clear = useCFUploadStore((state) => state.clear);

  const handleUpload = async (postId: number, { file, ...data }: ImageUpload) => {
    const { url, id, uuid, meta } = await upload<typeof data>({ file, meta: data });
    clear((item) => item.uuid === uuid);
    return await mutateAsync({ ...meta, url: id, postId });
  };

  const storeRef = useRef<EditPostStore>();
  if (!storeRef.current) {
    storeRef.current = createEditPostStore({ post, handleUpload });
  }

  useEffect(() => {
    Router.beforePopState(({ as }) => {
      if (as !== Router.asPath) {
        const id = post?.id;
        if (id) {
          queryUtils.post.get.invalidate({ id });
          // TODO.posts - additional post invalidation here
        }
      }
      return true;
    });
    return () => Router.beforePopState(() => true);
  }, [post?.id]); //eslint-disable-line

  return <EditPostContext.Provider value={storeRef.current}>{children}</EditPostContext.Provider>;
};

export function useEditPostContext<T>(selector: (state: EditPostState) => T) {
  const store = useContext(EditPostContext);
  if (!store) throw new Error('Missing EditPostContext.Provider in the tree');
  return useStore(store, selector);
}

const getImageDataFromFile = async (file: File) => {
  const url = URL.createObjectURL(file);
  const meta = await getMetadata(file);
  const resources: string[] = []; // TODO - get resources
  const img = await loadImage(url);
  const hashResult = blurHashImage(img);
  const auditResult = await auditMetaData(meta, false);
  const blockedFor = !auditResult?.success ? auditResult?.blockedFor : undefined;

  return {
    file,
    uuid: uuidv4(),
    name: file.name,
    meta,
    url,
    resources,
    ...hashResult,
    status: blockedFor ? 'aborted' : 'uploading',
    message: blockedFor?.filter(isDefined).join(', '),
  };
};
