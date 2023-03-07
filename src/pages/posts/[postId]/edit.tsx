import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import {
  Container,
  Title,
  Stack,
  Grid,
  Button,
  createStyles,
  Text,
  Group,
  Loader,
} from '@mantine/core';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { ReorderImages, ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { IconArrowsDownUp } from '@tabler/icons';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';

export default function PostEdit() {
  const { classes, cx } = useStyles();
  const id = useEditPostContext((state) => state.id);
  const reorder = useEditPostContext((state) => state.reorder);
  return (
    <Container>
      <Grid gutter={30}>
        <Grid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Title size="sm">POST</Title>
            <EditPostControls />
            <EditPostTags />

            <ReorderImagesButton>
              {({ onClick, isLoading, reorder }) => (
                <Button onClick={onClick} loading={isLoading}>
                  {reorder ? 'Done rearranging' : 'Rearrange images'}
                </Button>
              )}
            </ReorderImagesButton>
            {/* <ReorderImagesButton>
              {({ onClick, isLoading, reorder }) => (
                <Group onClick={onClick} spacing="xs">
                  {isLoading ? <Loader size="xs" /> : <IconArrowsDownUp size={16} />}
                  <Text> {reorder ? 'Done rearranging' : 'Rearrange'}</Text>
                </Group>
              )}
            </ReorderImagesButton> */}
            <DeletePostButton postId={id}>
              {({ onClick, isLoading }) => (
                <Button color="red" variant="filled" onClick={onClick} loading={isLoading}>
                  Delete Post
                </Button>
              )}
            </DeletePostButton>
          </Stack>
        </Grid.Col>
        <Grid.Col md={8} sm={6} orderSm={1}>
          <Stack>
            <EditPostTitle />
            {!reorder ? <EditPostImages /> : <ReorderImages />}
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}

PostEdit.getLayout = PostEditLayout;

const useStyles = createStyles((theme) => ({
  action: {},
}));
