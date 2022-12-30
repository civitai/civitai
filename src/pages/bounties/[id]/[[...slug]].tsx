import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Menu,
  NumberInput,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import {
  IconArrowLeft,
  IconDotsVertical,
  IconEdit,
  IconHeart,
  IconMessageCircle2,
  IconTrash,
  IconTrophy,
  IconViewfinder,
} from '@tabler/icons';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { BountyForm } from '~/components/Bounties/BountyForm';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { SFW } from '~/components/Media/SFW';
import { Meta } from '~/components/Meta/Meta';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeTags, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps: GetServerSideProps<
  { id: number; slug: string },
  { id: string; slug: string }
> = async (context) => {
  const { id, slug } = context.params ?? { id: '', slug: '' };
  if (!id || !isNumber(id)) return { notFound: true };

  const bountyId = Number(id);
  const ssg = await getServerProxySSGHelpers(context);
  await ssg.bounty.getById.prefetch({ id: bountyId });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id: bountyId,
      slug,
    },
  };
};

export default function BountyDetails(
  props: InferGetServerSidePropsType<typeof getServerSideProps>
) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();

  const { id, slug } = props;
  const { edit, showNsfw } = router.query;

  const { data: bounty } = trpc.bounty.getById.useQuery({ id });

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = bounty?.user.id === currentUser?.id || isModerator;
  const showNsfwRequested = showNsfw !== 'true';
  const userNotBlurringNsfw = currentUser?.blurNsfw !== false;
  const nsfw = userNotBlurringNsfw && showNsfwRequested && bounty?.nsfw === true;

  const deleteMutation = trpc.bounty.delete.useMutation({
    onSuccess() {
      showSuccessNotification({
        title: 'Your bounty has been deleted',
        message: 'Successfully deleted the bounty',
      });
      closeAllModals();
      router.replace('/bounties');
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete bounty',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });
  const handleDeleteBounty = () => {
    openConfirmModal({
      title: 'Delete Bounty',
      children: (
        <Text size="sm">
          Are you sure you want to delete this bounty? This action is destructive and you will have
          to contact support to restore your data.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Bounty', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        if (bounty) deleteMutation.mutate({ id: bounty.id });
      },
    });
  };

  if (!bounty) return <NotFound />;

  if (!!edit && bounty && isOwner) return <BountyForm bounty={bounty} />;
  if (nsfw && !currentUser)
    return (
      <>
        <Meta title={`${bounty.name} | Civitai`} description={removeTags(bounty.description)} />
        <SensitiveShield redirectTo={router.asPath} />;
      </>
    );

  const [coverImage] = bounty.images ?? [];
  const bountyDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: <Badge radius="sm">{splitUppercase(bounty.type)}</Badge>,
    },
    {
      label: 'Posted',
      value: <Text>{formatDate(bounty.createdAt)}</Text>,
    },
    {
      label: 'Deadline',
      value: bounty.deadline ? <Text>{formatDate(bounty.deadline)}</Text> : null,
      visible: !!bounty.deadline,
    },
    {
      label: 'Training Data',
      // Update href when download endpoint is available
      value: (
        <Text variant="link" component="a" href={`#`} target="_blank" download>
          Download
        </Text>
      ),
      visible: !!bounty.file,
    },
    {
      label: 'Tags',
      value: (
        <Group spacing={4}>
          {bounty.tags.map((tag) => (
            <Badge key={tag.id} color="blue" size="sm" radius="sm">
              {tag.name}
            </Badge>
          ))}
        </Group>
      ),
    },
  ];

  return (
    <>
      <Meta
        title={`${bounty.name} | Civitai`}
        description={removeTags(bounty.description ?? '')}
        image={coverImage?.url ? getEdgeUrl(coverImage.url, { width: 1200 }) : undefined}
      />
      <Container size="xl">
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Group position="apart">
              <Group align="center" spacing="lg">
                <Link href="/bounties" passHref>
                  <ActionIcon component="a" variant="outline" size="lg">
                    <IconArrowLeft size={20} stroke={1.5} />
                  </ActionIcon>
                </Link>
                <Title order={1} sx={{ lineHeight: 1 }}>
                  {bounty.name}
                </Title>
                <Group spacing={4}>
                  <IconBadge
                    icon={<IconTrophy size={18} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    color="yellow"
                    size="lg"
                  >
                    <Text size="sm">{abbreviateNumber(bounty.rank?.bountyValueAllTime ?? 0)}</Text>
                  </IconBadge>
                  <LoginRedirect reason="favorite-model">
                    <IconBadge
                      radius="sm"
                      size="lg"
                      icon={<IconHeart size={18} />}
                      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                      sx={{ cursor: 'pointer' }}
                    >
                      <Text size="sm">
                        {abbreviateNumber(bounty.rank?.favoriteCountAllTime ?? 0)}
                      </Text>
                    </IconBadge>
                  </LoginRedirect>
                  <IconBadge
                    icon={<IconMessageCircle2 size={18} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    size="lg"
                  >
                    <Text size="sm">{abbreviateNumber(bounty.rank?.commentCountAllTime ?? 0)}</Text>
                  </IconBadge>
                  <IconBadge
                    icon={<IconViewfinder size={18} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    size="lg"
                  >
                    <Text size="sm">{abbreviateNumber(bounty.rank?.hunterCountAllTime ?? 0)}</Text>
                  </IconBadge>
                </Group>
              </Group>
              <Menu position="bottom-end" transition="pop-top-right">
                <Menu.Target>
                  <ActionIcon variant="outline">
                    <IconDotsVertical size={16} />
                  </ActionIcon>
                </Menu.Target>

                <Menu.Dropdown>
                  {currentUser && isOwner && (
                    <>
                      <Menu.Item
                        color="red"
                        icon={<IconTrash size={14} stroke={1.5} />}
                        onClick={handleDeleteBounty}
                      >
                        Delete Bounty
                      </Menu.Item>
                      <Menu.Item
                        component={NextLink}
                        href={`/bounties/${id}/${slug}?edit=true`}
                        icon={<IconEdit size={14} stroke={1.5} />}
                        shallow
                      >
                        Edit Bounty
                      </Menu.Item>
                    </>
                  )}
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Grid.Col>
          <Grid.Col xs={12} sm={5} md={4} orderSm={2}>
            <Stack>
              <Group spacing="xs" style={{ flexWrap: 'nowrap' }}>
                <NumberInput
                  name="contribution"
                  placeholder="Set an amount"
                  min={1}
                  icon={<IconTrophy size={18} stroke={1.5} color="gold" />}
                  sx={{ flex: 1 }}
                  hideControls
                />
                <Button>Add to Bounty</Button>
                <LoginRedirect reason="favorite-model">
                  <Tooltip label="Hunt" position="bottom" withArrow>
                    <Button
                      color="green"
                      sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                    >
                      <IconViewfinder color="#fff" />
                    </Button>
                  </Tooltip>
                </LoginRedirect>
              </Group>
              <DescriptionTable items={bountyDetails} labelWidth="30%" />
            </Stack>
          </Grid.Col>
          <Grid.Col
            xs={12}
            sm={7}
            md={8}
            orderSm={1}
            sx={(theme) => ({
              [theme.fn.largerThan('xs')]: {
                padding: `0 ${theme.spacing.sm}px`,
                margin: `${theme.spacing.sm}px 0`,
              },
            })}
          >
            <Stack spacing="xl">
              <SFW type="model" id={bounty.id} nsfw={bounty.nsfw}>
                {({ nsfw, showNsfw }) => (
                  <>
                    <SFW.Placeholder>
                      <Card
                        p="md"
                        radius="sm"
                        withBorder
                        sx={{
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%,-50%)',
                          zIndex: 10,
                        }}
                      >
                        <Stack>
                          <Text>This bounty has been marked NSFW</Text>
                          <SFW.Toggle>
                            <Button>Click to view</Button>
                          </SFW.Toggle>
                        </Stack>
                      </Card>
                    </SFW.Placeholder>
                    <Carousel
                      slideSize="50%"
                      breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
                      slideGap="xl"
                      align={bounty.images.length > 2 ? 'start' : 'center'}
                      withControls={bounty.images.length > 2 ? true : false}
                      loop
                    >
                      {bounty.images.map(({ index, ...image }) => (
                        <Carousel.Slide key={image.id}>
                          <Center style={{ height: '100%' }}>
                            <ImagePreview
                              image={image}
                              edgeImageProps={{ width: 400 }}
                              nsfw={nsfw && !showNsfw}
                              radius="md"
                              style={{ width: '100%' }}
                              withMeta
                            />
                          </Center>
                        </Carousel.Slide>
                      ))}
                    </Carousel>
                  </>
                )}
              </SFW>
              <ContentClamp maxHeight={300}>
                <Title order={2}>About this bounty</Title>
                <RenderHtml html={bounty.description} />
              </ContentClamp>
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
