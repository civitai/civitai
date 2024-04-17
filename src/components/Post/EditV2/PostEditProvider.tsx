import { PostDetailEditable } from '~/server/services/post.service';
import React, { createContext, useContext, useEffect, useRef } from 'react';
import { PostEditQuerySchema } from '~/server/schema/post.schema';
import { trpc } from '~/utils/trpc';
import { PostEditForm } from '~/components/Post/EditV2/PostEditForm';
import { PostImagesProvider } from '~/components/Post/EditV2/PostImagesProvider';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { PostImages } from '~/components/Post/EditV2/PostImages';
import { Loader } from '@mantine/core';

// #region [types]
type ContextProps = {
  post?: PostDetailEditable;
  params: PostEditQuerySchema;
};

type Props = {
  post?: PostDetailEditable;
  params?: PostEditQuerySchema;
  onCreate?: (post: PostDetailEditable) => void;
  onPublish?: (post: PostDetailEditable) => void;
};
// #endregion

// #region [context]

const Context = createContext<ContextProps | null>(null);
export const usePostEditContext = () => {
  const context = useContext(Context);
  if (!context) throw new Error('missing PostEditProvider');
  return context;
};
// #endregion

export function PostEditProvider({ post, params = {}, onCreate, onPublish }: Props) {
  // #region [state]
  const queryUtils = trpc.useUtils();
  const enableQuery = !!params.postId;
  const { data = post, isLoading } = trpc.post.getEdit.useQuery(
    { id: params.postId ?? 0 },
    { enabled: enableQuery, initialData: post }
  );

  if (data) {
    params.postId = data.id;
    params.modelVersionId = data.modelVersionId;
  }
  // #endregion

  // #region [data invalidation]
  const postId = data?.id;
  useEffect(() => {
    if (postId) {
      const handleReturn = async () => {
        await queryUtils.post.get.invalidate({ id: postId });
        await queryUtils.post.getEdit.invalidate({ id: postId });
        await queryUtils.post.getInfinite.invalidate();
      };
      return () => {
        handleReturn();
      };
    }
  }, [postId]); // eslint-disable-line
  // #endregion

  // #region [render loader]
  if (enableQuery && isLoading)
    return (
      <div className="flex justify-center items-center py-10">
        <Loader />
      </div>
    );
  // #endregion

  // #region [no content]
  if (enableQuery && !data) return <></>;
  // #endregion

  // #region [content]
  return (
    <Context.Provider value={{ post: data, params }}>
      <div className="@container">
        <div className="flex flex-col gap-3">
          {data && <PostEditForm />}
          <PostImagesProvider>
            <PostImageDropzone onCreatePost={onCreate} />
            <PostImages />
          </PostImagesProvider>
        </div>
      </div>
    </Context.Provider>
  );
  // #endregion
}
