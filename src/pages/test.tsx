import { Button, Container, Group, SegmentedControl } from '@mantine/core';
import { usePicFinder } from '~/libs/picfinder';

const prompts = {
  tiger: 'tiger',
  mouse: 'mouse -no cartoon, animated, cat',
  woman: 'woman -no bikini, animated, underwear, nsfw',
  dog: 'dog',
};

export default function Test() {
  const { images, loading, prompt, getImages, setPrompt, clear } = usePicFinder({
    initialPrompt: prompts.tiger,
    initialFetchCount: 3,
  });

  return (
    <Container>
      <h1>Test</h1>
      <Group mb="md">
        <SegmentedControl
          value={prompt}
          onChange={(value) => setPrompt(value)}
          data={Object.entries(prompts).map(([key, value]) => ({
            label: key,
            value,
          }))}
        />
        <Button onClick={() => getImages(3)} loading={loading}>
          Get Image
        </Button>
        <Button onClick={() => clear()} variant="outline">
          Clear
        </Button>
      </Group>
      <Group>
        {images?.map((url) => (
          <img key={url} src={url} style={{ width: 'calc(33% - 16px)' }} />
        ))}
      </Group>
    </Container>
  );
}
