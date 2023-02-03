import { Button, Code, Container, Group, Stack } from '@mantine/core';
import { useCivitaiLink, useCivitaiLinkStore } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { Meta } from '~/components/Meta/Meta';

function Home() {
  const activities = useCivitaiLinkStore((state) => state.activities);
  const { resources, connected, runCommand } = useCivitaiLink();

  const handleRunDownload = async () => {
    runCommand({
      type: 'resources:add',
      resources: [
        {
          type: 'Checkpoint',
          hash: 'DC4C67171E2EB64B1A79DA7FDE1CB3FCBEF65364B12C8F5E30A0141FD8C88233',
          name: 'synthwavepunk_v2.ckpt',
          url: 'https://civitai.com/api/download/models/1144',
          previewImage:
            'https://imagecache.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3cabeab1-a1c9-4a02-ac76-3a9ed69a1700/width=450',
        },
        {
          name: 'dalcefoV3Anime_dalcefoV3Anime.safetensors',
          hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
          url: 'https://civitai.com/api/download/models/6278',
          type: 'Checkpoint',
          previewImage:
            'https://imagecache.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/35b84925-765b-416b-0c5a-15bf54a64c00/width=450',
        },
      ],
    });
  };

  const handleCancelDownload = async () => {
    runCommand({
      type: 'resources:add:cancel',
      resources: [
        {
          hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
          type: 'Checkpoint',
        },
      ],
    });
  };

  const handleDeleteResource = async () => {
    runCommand({
      type: 'resources:remove',
      resources: [
        {
          hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
          type: 'Checkpoint',
        },
      ],
    });
  };

  return (
    <>
      <Container size="xl">
        <h1>Connected</h1>
        {connected ? 'true' : 'false'}
        {connected && (
          <Group>
            <Button onClick={handleRunDownload}>Run Download</Button>
            <Button onClick={handleCancelDownload}>Cancel Download</Button>
            <Button onClick={handleDeleteResource}>Remove Downloaded</Button>
          </Group>
        )}
        <h1>Activities</h1>
        <Stack>
          {activities &&
            activities.map((x) => (
              <Code block key={x.id}>
                {JSON.stringify(x, null, 4)}
              </Code>
            ))}
        </Stack>
        <h1>resources</h1>
        <Stack>
          {resources &&
            resources.map((x) => (
              <Code block key={x.name}>
                {JSON.stringify(x, null, 4)}
              </Code>
            ))}
        </Stack>
      </Container>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
