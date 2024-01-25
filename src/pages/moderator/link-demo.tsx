import {
  Button,
  Code,
  Container,
  CopyButton,
  Group,
  List,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';

// export const getServerSideProps = createServerSideProps({
//   useSession: true,
//   resolver: async ({ session }) => {
//     if (!session?.user?.isModerator || session.user?.bannedAt) {
//       return {
//         redirect: {
//           destination: '/',
//           permanent: false,
//         },
//       };
//     }
//   },
// });

function Home() {
  // const activities = useCivitaiLinkStore((state) => state.activities);
  const { resources, connected, runCommand, instance } = useCivitaiLink();

  const handleRunDownload = async () => {
    runCommand({
      type: 'resources:add',
      resource: {
        type: 'Checkpoint',
        hash: 'DC4C67171E2EB64B1A79DA7FDE1CB3FCBEF65364B12C8F5E30A0141FD8C88233',
        name: 'synthwavepunk_v2.ckpt',
        url: 'https://civitai.com/api/download/models/1144',
        previewImage:
          'https://imagecache.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3cabeab1-a1c9-4a02-ac76-3a9ed69a1700/width=450',
        modelName: 'SynthwavePunk',
        modelVersionName: 'V2',
      },
    });

    runCommand({
      type: 'resources:add',
      resource: {
        name: 'dalcefoV3Anime_dalcefoV3Anime.safetensors',
        modelName: 'dalcefo_v3_anime_pastelMix',
        modelVersionName: 'dalcefo_v3_anime_pastelMix',
        hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
        url: 'https://civitai.com/api/download/models/6278',
        type: 'Checkpoint',
        previewImage:
          'https://imagecache.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/35b84925-765b-416b-0c5a-15bf54a64c00/width=450',
      },
    });
  };

  // const handleCancelDownload = async () => {
  //   runCommand({
  //     type: 'resources:add:cancel',
  //     resource: {
  //       hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
  //       type: 'Checkpoint',
  //     },
  //   });
  // };

  const handleDeleteResource = async () => {
    runCommand({
      type: 'resources:remove',
      resource: {
        hash: 'D62D1A7201EDA514E110A291571F9E2D1FC2D620F9C77B54B2C4CB1B3620C34B',
        type: 'Checkpoint',
        modelName: 'dalcefo_v3_anime_pastelMix',
        modelVersionName: 'dalcefo_v3_anime_pastelMix',
      },
    });
  };

  const handleClearActivities = async () => {
    runCommand({
      type: 'activities:clear',
    });
  };

  // const activitiesList = Object.values(activities);

  return (
    <>
      <Container size="xl">
        <Stack spacing={4}>
          <Title order={3} mb={0} sx={{ lineHeight: 1 }}>
            Link your account
          </Title>
          <Text mb="md" color="dimmed">
            Time to connect your Stable Diffusion instance to your Civitai Account.
          </Text>
          <List type="ordered">
            <List.Item>
              In your{' '}
              <Text td="underline" component="span">
                SD Settings
              </Text>
              , open the{' '}
              <Text td="underline" component="span">
                Civitai
              </Text>{' '}
              tab
            </List.Item>
            <List.Item>
              Paste the Link Key below into the{' '}
              <Text td="underline" component="span">
                Link Key
              </Text>{' '}
              field
            </List.Item>
            <List.Item>
              <Text td="underline" component="span">
                Save
              </Text>{' '}
              your settings
            </List.Item>
          </List>
          <Stack align="center" spacing={5} my="lg">
            <Title order={4}>Link Key</Title>
            {instance?.key ? (
              <CopyButton value={instance.key}>
                {({ copied, copy }) => (
                  <Tooltip label="copy">
                    <Button
                      variant="default"
                      onClick={copy}
                      size="lg"
                      px="sm"
                      rightIcon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    >
                      {!copied ? instance.key : 'Copied'}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            ) : (
              <Button variant="default" size="lg" px="sm">
                <Group spacing="xs" align="center">
                  <Loader size="sm" />
                  <span>Generating key</span>
                </Group>
              </Button>
            )}
          </Stack>
        </Stack>

        <h1>Connected</h1>
        {connected ? 'true' : 'false'}
        {connected && (
          <Group>
            <Button onClick={handleRunDownload}>Run Download</Button>
            {/* <Button onClick={handleCancelDownload}>Cancel Download</Button> */}
            <Button onClick={handleDeleteResource}>Remove Downloaded</Button>
            <Button onClick={handleClearActivities}>Clear Activities</Button>
          </Group>
        )}
        <h1>Activities</h1>
        {/* <Stack>
          {activitiesList &&
            activitiesList.map((x) => (
              <Code block key={x.id}>
                {JSON.stringify(x, null, 4)}
              </Code>
            ))}
        </Stack> */}
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

export default Home;
