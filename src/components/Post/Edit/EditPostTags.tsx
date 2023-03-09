import { Stack, MultiSelect, Center, Loader } from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { useEditPostContext } from './EditPostProvider';
import { TagsInput } from '~/components/Tags/TagsInput';
import { trpc } from '~/utils/trpc';
import { PostTagsPicker } from '~/components/Post/Edit/PostTagPicker';

export function EditPostTags() {
  const tags = useEditPostContext((state) => state.tags);
  const setTags = useEditPostContext((state) => state.setTags);

  const { data, isLoading } = trpc.tag.getAll.useQuery({
    entityType: [TagTarget.Post],
    limit: 0,
    categories: true,
  });

  const handleSetCategories = (tagNames: string[]) => {
    // check if tags have been removed
    // check if tags have been added
    setTags((state) => {
      const nonCategoryTags = state.filter((x) => !x.isCategory);
      const categoryTags = state.filter((x) => x.isCategory);
      const updatedCategoryTags = tagNames.map((name) => ({
        id: categoryTags.find((x) => x.name === name)?.id,
        name,
        isCategory: true,
      }));
      return [...updatedCategoryTags, ...nonCategoryTags];
    });
  };

  const handleSetTags = (incoming: { id?: number; name: string }[]) => {
    // check if tags have been removed
    // check if tags have been added
    const nonCategoryTags = incoming.map((tag) => ({ ...tag, isCategory: false }));
    setTags((state) => {
      const categoryTags = state.filter((x) => x.isCategory);
      return [...categoryTags, ...nonCategoryTags];
    });
  };

  return (
    <Stack>
      <PostTagsPicker value={tags} />
      {/* <MultiSelect
        label="Categories"
        data={data?.items.map((tag) => tag.name).sort() ?? []}
        value={tags.filter((x) => x.isCategory).map((x) => x.name)}
        onChange={handleSetCategories}
        rightSection={
          isLoading ? (
            <Center>
              <Loader size="xs" />
            </Center>
          ) : undefined
        }
      />
      <TagsInput
        label="Tags"
        value={tags.filter((x) => !x.isCategory)}
        onChange={handleSetTags}
        target={[TagTarget.Post]}
      /> */}
    </Stack>
  );
}
