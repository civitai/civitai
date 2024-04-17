import { Badge, Button, Container, Group, Stack, Title, Center, Loader } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';
import { PostEditor } from '~/components/Post/EditV2/PostEditor';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import { trpc } from '~/utils/trpc';

export default function PostEdit() {
  const router = useRouter();
  const params = postEditQuerySchema.parse(router.query);

  // const { data, isLoading } = trpc.post.getEdit.useQuery({ id: params.postId });

  // if (isLoading)
  //   return (
  //     <Center p="xl">
  //       <Loader />
  //     </Center>
  //   );

  return (
    <Container size="xl">
      <PostEditor params={params} />
    </Container>
  );
}

// export default function PostEdit() {
//   const id = useEditPostContext((state) => state.id);
//   const mutating = useIsMutating();
//   const reorder = useEditPostContext((state) => state.reorder);
//   const publishedAt = useEditPostContext((state) => state.publishedAt);
//   const deleting = useEditPostContext((state) => state.deleting);
//   const setDeleting = useEditPostContext((state) => state.setDeleting);

//   useCatchNavigation({
//     unsavedChanges: !publishedAt && !deleting,
//     message: `You haven't published this post, all images will stay hidden. Do you wish to continue?`,
//   });

//   return (
//     <Container>
//       <ContainerGrid gutter={30}>
//         <ContainerGrid.Col md={4} sm={6} orderSm={2}>
//           <Stack>
//             <Group position="apart">
//               <Title size="sm">POST</Title>
//               <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
//                 {mutating > 0 ? 'Saving' : 'Saved'}
//               </Badge>
//             </Group>
//             <EditPostControls />
//             <EditPostReviews />
//             <DeletePostButton postId={id}>
//               {({ onClick, isLoading }) => (
//                 <Button
//                   onClick={() => {
//                     onClick(setDeleting);
//                   }}
//                   color="red"
//                   loading={isLoading}
//                   variant="outline"
//                   leftIcon={<IconTrash size={20} />}
//                   mt={50}
//                 >
//                   Delete Post
//                 </Button>
//               )}
//             </DeletePostButton>
//           </Stack>
//         </ContainerGrid.Col>
//         <ContainerGrid.Col md={8} sm={6} orderSm={1}>
//           <Stack>
//             <Stack spacing={0}>
//               <EditPostTitle />
//               <EditPostTags />
//             </Stack>
//             <EditPostDetail />
//             {!reorder ? <EditPostImages /> : <ReorderImages />}
//           </Stack>
//         </ContainerGrid.Col>
//       </ContainerGrid>
//     </Container>
//   );
// }

// setPageOptions(PostEdit, { innerLayout: PostEditLayout });
// PostEdit.getLayout = PostEditLayout;
