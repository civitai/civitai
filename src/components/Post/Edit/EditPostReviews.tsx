import { Stack, Alert, Text, Card, Group, Rating } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditImage } from '~/server/controllers/post.controller';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { removeDuplicates } from '~/utils/array-helpers';

export function EditPostReviews() {
  const images = useEditPostContext((state) => state.images);

  const resources = images
    .filter((x) => x.type === 'image')
    .flatMap((x) => (x.data as PostEditImage).resources)
    .map((x) => x.modelVersion)
    .filter(isDefined);

  const uniqueResources = removeDuplicates(resources, 'id');
  const resourceIds = uniqueResources.map((x) => x.id);
  const missingResources = !resources.length;

  const { data, isLoading } = trpc.resourceReview.get.useQuery(
    { resourceIds },
    { enabled: !!resourceIds.length }
  );

  return (
    <Stack>
      <Stack>
        {uniqueResources
          .sort((a, b) => {
            const textA = a.model.name;
            const textB = b.model.name;
            return textA < textB ? -1 : textA > textB ? 1 : 0;
          })
          .map((resource) => (
            <Card key={resource.id} p={8} withBorder>
              <Stack>
                <Group spacing={4}>
                  <Text lineClamp={1} size="sm" weight={500}></Text>
                </Group>
              </Stack>
            </Card>
          ))}
      </Stack>

      {missingResources && (
        <Alert color="yellow">
          <Text size="xs">
            Some of your images are missing resources. For automatic image resource detection, try
            installing{' '}
            <Text
              component="a"
              href="https://github.com/civitai/sd_civitai_extension"
              target="_blank"
              variant="link"
            >
              Civitai Extension for Automatic 1111 Stable Diffusion Web UI
            </Text>
          </Text>
        </Alert>
      )}
    </Stack>
  );
}

function ResourceWithReview({}) {
  return <></>;
}

function ResourceWithoutReview({}) {
  return <></>;
}
