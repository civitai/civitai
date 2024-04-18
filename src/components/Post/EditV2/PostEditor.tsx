import { PostDetailEditable } from '~/server/services/post.service';
import React, { createContext, useContext, useEffect } from 'react';
import { PostEditQuerySchema } from '~/server/schema/post.schema';
import { trpc } from '~/utils/trpc';
import { PostEditForm } from '~/components/Post/EditV2/PostEditForm';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards';
import { Loader } from '@mantine/core';
import { PostEditSidebar } from '~/components/Post/EditV2/PostEditSidebar';
import {
  PostImagesProvider,
  usePostImagesContext,
} from '~/components/Post/EditV2/PostImagesProvider';
import { PostReorderImages } from '~/components/Post/EditV2/PostReorderImages';
import { produce } from 'immer';

// #region [types]
type ContextProps = {
  post?: PostDetailEditable;
  params: PostEditQuerySchema;
  onCreate?: (post: PostDetailEditable) => void;
  onPublish?: (post: PostDetailEditable) => void;
  updatePostState: (cb: (data: PostDetailEditable) => void) => void;
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

export function PostEditor({ post, params = {}, onCreate, onPublish }: Props) {
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

  // #region [update Post State]
  const updatePostState = (cb: (data: PostDetailEditable) => void) => {
    queryUtils.post.getEdit.setData(
      { id: post?.id ?? 0 },
      produce((data) => {
        if (data) cb(data);
      })
    );
  };
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

  // #region [providers]
  return (
    <Context.Provider value={{ post: data, params, onCreate, onPublish, updatePostState }}>
      <PostImagesProvider>
        <PostEditorInner />
      </PostImagesProvider>
    </Context.Provider>
  );
  // #endregion
}

// #region [content]
function PostEditorInner() {
  const { post, onCreate } = usePostEditContext();
  const isReordering = usePostImagesContext((state) => state.isReordering);

  return (
    <div className="@container flex gap-3">
      <div className="flex flex-col gap-3 @md:w-9/12">
        {post && <PostEditForm />}
        {!isReordering ? (
          <>
            <PostImageDropzone onCreatePost={onCreate} />
            <PostImageCards />
          </>
        ) : (
          <PostReorderImages />
        )}
      </div>
      {post && (
        <div className="flex flex-col gap-3 @md:w-3/12">
          <PostEditSidebar post={post} />
        </div>
      )}
    </div>
  );
}

// #endregion
