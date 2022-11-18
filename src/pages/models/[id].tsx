import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Container,
  CopyButton,
  createStyles,
  Grid,
  Group,
  Loader,
  Menu,
  MultiSelect,
  Select,
  Stack,
  Text,
  Title,
  useMantineTheme,
  Modal,
  Alert,
  ThemeIcon,
} from '@mantine/core';
import { closeAllModals, openConfirmModal, openContextModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ModelStatus, ReportReason } from '@prisma/client';
import {
  IconArrowsSort,
  IconBan,
  IconCopy,
  IconDotsVertical,
  IconEdit,
  IconExclamationMark,
  IconFilter,
  IconFlag,
  IconLicense,
  IconPlus,
  IconTrash,
} from '@tabler/icons';
import startCase from 'lodash/startCase';
import { GetServerSideProps } from 'next';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { InView } from 'react-intersection-observer';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { Meta } from '~/components/Meta/Meta';
import { ModelForm } from '~/components/Model/ModelForm/ModelForm';
import { ModelReviews } from '~/components/Model/ModelReviews/ModelReviews';
import { ModelVersions } from '~/components/Model/ModelVersions/ModelVersions';
import { ModelRating } from '~/components/ModelRating/ModelRating';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { isNumber } from '~/utils/type-guards';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { VerifiedShield } from '~/components/VerifiedShield/VerifiedShield';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

type PageProps = {
  id: number;
};

export const getServerSideProps: GetServerSideProps<{ id: number }> = async (context) => {
  const ssg = await getServerProxySSGHelpers(context);
  const id = Number(context.params?.id as string);
  if (isNumber(id)) await ssg.model.getById.prefetch({ id });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id,
    },
  };
};

const useStyles = createStyles((theme) => ({
  actions: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },

  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
    },
  },
}));

export default function ModelDetail(props: PageProps) {
  const theme = useMantineTheme();
  const router = useRouter();
  const { data: session } = useSession();
  const { classes } = useStyles();
  const mobile = useIsMobile();
  const queryUtils = trpc.useContext();

  const { id } = props;
  const { edit } = router.query;

  const [reviewFilters, setReviewFilters] = useState<{
    filterBy: ReviewFilter[];
    sort: ReviewSort;
  }>({
    filterBy: [],
    sort: ReviewSort.Newest,
  });

  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery({ id });
  const {
    data: reviewsData,
    isLoading: loadingReviews,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = trpc.review.getAll.useInfiniteQuery(
    { modelId: id, limit: 5, ...reviewFilters },
    {
      enabled: !edit,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      keepPreviousData: true,
    }
  );
  const nsfw = router.query.showNsfw !== 'true' && !!model?.nsfw;

  const deleteMutation = trpc.model.delete.useMutation({
    onSuccess() {
      showSuccessNotification({
        title: 'Your model has been deleted',
        message: 'Successfully deleted the model',
      });
      closeAllModals();
      router.replace('/'); // Redirect to the models or user page once available
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete model',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });
  const reportModelMutation = trpc.model.report.useMutation({
    onMutate() {
      showNotification({
        id: 'sending-report',
        loading: true,
        disallowClose: true,
        autoClose: false,
        message: 'Sending report...',
      });
    },
    async onSuccess(_, variables) {
      showSuccessNotification({
        title: 'Model reported',
        message: 'Your request has been received',
      });
      await queryUtils.model.getById.invalidate({ id: variables.id });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: 'An unexpected error occurred, please try again',
      });
    },
    onSettled() {
      hideNotification('sending-report');
    },
  });
  const unpublishModelMutation = trpc.model.unpublish.useMutation({
    onSuccess() {
      queryUtils.model.getById.invalidate({ id });
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const reviews = useMemo(
    () => reviewsData?.pages.flatMap((x) => x.reviews) ?? [],
    [reviewsData?.pages]
  );
  const isModerator = session?.user?.isModerator ?? false;
  const isOwner = model?.user.id === session?.user?.id || isModerator;

  // when a user navigates back in their browser, set the previous url with the query string model={id}
  useEffect(() => {
    router.beforePopState(({ as }) => {
      if (as.startsWith('/?')) {
        const [route, queryString] = as.split('?');
        const queryParams = QS.parse(queryString);
        // const stringified = QS.stringify({ ...queryParams, model: id });
        // const url = stringified ? `${route}?${stringified}` : route;
        setTimeout(() => {
          router.replace({ pathname: route, query: { ...queryParams, model: id } }, undefined, {
            shallow: true,
          });
        }, 0);
        // Will run when leaving the current page; on back/forward actions
        // Add your logic here, like toggling the modal state
      }
      return true;
    });

    return () => router.beforePopState(() => true);
  }, [router, id]); // Add any state variables to dependencies array if needed.

  // Latest version is the first one based on sorting (createdAt - desc)
  const latestVersion = model?.modelVersions[0];

  if (loadingModel)
    return (
      <Container size="xl">
        <Center>
          <Loader size="xl" />
        </Center>
      </Container>
    );
  if (!model) return <NotFound />;
  if (!!edit && model && isOwner) return <ModelForm model={model} />;
  if (model.nsfw && !session) return <SensitiveShield redirectTo={router.asPath} />;

  const handleDeleteModel = () => {
    openConfirmModal({
      title: 'Delete Model',
      children: (
        <Text size="sm">
          Are you sure you want to delete this model? This action is destructive and you will have
          to contact support to restore your data.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        if (model) {
          deleteMutation.mutate({ id: model.id });
        }
      },
    });
  };

  const handleReviewFilterChange = (values: ReviewFilter[]) => {
    setReviewFilters((current) => ({
      ...current,
      filterBy: values,
    }));
  };

  const handleReviewSortChange = (value: ReviewSort) => {
    setReviewFilters((current) => ({
      ...current,
      sort: value,
    }));
  };

  const handleReportModel = (reason: ReportReason) => {
    reportModelMutation.mutate({ id, reason });
  };

  const handleUnpublishModel = () => {
    unpublishModelMutation.mutate({ id });
  };

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Group position="apart">
          <Badge radius="sm">{splitUppercase(model?.type)}</Badge>
          {model?.status !== ModelStatus.Published && (
            <Badge color="yellow" radius="sm">
              {model.status}
            </Badge>
          )}
        </Group>
      ),
    },
    {
      label: 'Downloads',
      value: <Text>{(model?.rank?.downloadCountAllTime ?? 0).toLocaleString()}</Text>,
    },
    {
      label: 'Last Update',
      value: <Text>{formatDate(model?.updatedAt)}</Text>,
    },
    {
      label: 'Versions',
      value: <Text>{model?.modelVersions.length}</Text>,
    },
    {
      label: 'Tags',
      value: (
        <Group spacing={4}>
          {model.tagsOnModels.map(({ tag }) => (
            <Badge key={tag.id} color={tag.color ?? 'blue'} size="sm" radius="sm">
              {tag.name}
            </Badge>
          ))}
        </Group>
      ),
    },
    {
      // TODO DRY: We're doing this same thing here and in the modelversions
      label: 'Trained Words',
      visible: !!latestVersion?.trainedWords?.length,
      value: (
        <Group spacing={4}>
          {latestVersion?.trainedWords.map((word, index) => (
            <CopyButton key={index} value={word}>
              {({ copy }) => (
                <Badge
                  radius="sm"
                  size="sm"
                  color="violet"
                  sx={{ cursor: 'pointer', height: 'auto' }}
                  onClick={() => {
                    copy();
                    showNotification({ message: 'Copied trained word!', color: 'teal' });
                  }}
                  rightSection={<IconCopy stroke={1.5} size={12} />}
                >
                  <Group spacing={4} align="center" noWrap sx={{ whiteSpace: 'normal' }}>
                    {word}
                  </Group>
                </Badge>
              )}
            </CopyButton>
          ))}
        </Group>
      ),
    },
    {
      label: 'Uploaded By',
      value: model.user && (
        <Link href={`/?user=${model.user.username}`} passHref>
          <Text size="sm" variant="link" component="a" style={{ cursor: 'pointer' }}>
            <Group align="center" spacing={4}>
              <UserAvatar user={model.user} avatarProps={{ size: 'sm' }} />
              {model.user.username}
            </Group>
          </Text>
        </Link>
      ),
    },
  ];
  const published = model.status === ModelStatus.Published;

  return (
    <>
      <Meta
        title={`Civitai - ${model.name}`}
        description={model.description ?? ''}
        image={
          model.nsfw || latestVersion?.images[0]?.image.url == null
            ? undefined
            : getEdgeUrl(latestVersion.images[0].image.url, { width: 1200 })
        }
      />

      <Container size="xl" pt={0} pb="xl" px={0}>
        <Stack spacing="xs" mb="xl">
          <Group align="center" sx={{ justifyContent: 'space-between' }}>
            <Group align="center">
              <Title className={classes.title} order={1} sx={{ paddingBottom: mobile ? 0 : 8 }}>
                {model?.name}
              </Title>
              <ModelRating rank={model.rank} size="lg" />
            </Group>
            <Menu position="bottom-end" transition="pop-top-right">
              <Menu.Target>
                <ActionIcon variant="outline">
                  <IconDotsVertical size={16} />
                </ActionIcon>
              </Menu.Target>

              <Menu.Dropdown>
                {session && isOwner ? (
                  <>
                    <Menu.Item
                      color={theme.colors.red[6]}
                      icon={<IconTrash size={14} stroke={1.5} />}
                      onClick={handleDeleteModel}
                    >
                      Delete Model
                    </Menu.Item>
                    <Menu.Item
                      component={NextLink}
                      href={`/models/${id}?edit=true`}
                      icon={<IconEdit size={14} stroke={1.5} />}
                      shallow
                    >
                      Edit Model
                    </Menu.Item>
                  </>
                ) : null}
                {session && isOwner && published ? (
                  <Menu.Item
                    icon={<IconBan size={14} stroke={1.5} />}
                    color="yellow"
                    onClick={handleUnpublishModel}
                    disabled={unpublishModelMutation.isLoading}
                  >
                    Unpublish
                  </Menu.Item>
                ) : null}
                {!session || !isOwner || isModerator ? (
                  <>
                    <LoginRedirect reason="report-model">
                      <Menu.Item
                        icon={<IconFlag size={14} stroke={1.5} />}
                        onClick={() => handleReportModel(ReportReason.NSFW)}
                        disabled={reportModelMutation.isLoading}
                      >
                        Report as NSFW
                      </Menu.Item>
                    </LoginRedirect>
                    <LoginRedirect reason="report-model">
                      <Menu.Item
                        icon={<IconFlag size={14} stroke={1.5} />}
                        onClick={() => handleReportModel(ReportReason.TOSViolation)}
                        disabled={reportModelMutation.isLoading}
                      >
                        Report as Terms Violation
                      </Menu.Item>
                    </LoginRedirect>
                  </>
                ) : null}
              </Menu.Dropdown>
            </Menu>
          </Group>
          {model.status === ModelStatus.Unpublished && (
            <Alert color="red">
              <Group spacing="xs" noWrap align="flex-start">
                <ThemeIcon color="red">
                  <IconExclamationMark />
                </ThemeIcon>
                <Text size="md">
                  This model has been unpublished because it looks like the model file failed to
                  upload. Please re-upload the file.
                </Text>
              </Group>
            </Alert>
          )}
        </Stack>
        <Grid gutter="xl">
          <Grid.Col xs={12} sm={5} md={4} orderSm={2}>
            <Stack>
              {latestVersion && (
                <Group spacing="xs">
                  <LoginRedirect reason="download-auth">
                    <Button
                      component="a"
                      href={`/api/download/models/${latestVersion?.id}`}
                      fullWidth={mobile}
                      sx={{ flex: 1 }}
                      download
                    >
                      <Text align="center">
                        {`Download Latest (${formatKBytes(latestVersion?.modelFile?.sizeKB ?? 0)})`}
                      </Text>
                    </Button>
                  </LoginRedirect>
                  <VerifiedShield file={latestVersion.modelFile} />
                </Group>
              )}

              <DescriptionTable items={modelDetails} labelWidth="30%" />
              {model?.type === 'Checkpoint' && (
                <Group position="right" spacing="xs">
                  <IconLicense size={16} />
                  <Text size="xs" color="dimmed">
                    License:{' '}
                    <Text
                      component="a"
                      href="https://huggingface.co/spaces/CompVis/stable-diffusion-license"
                      rel="nofollow"
                      td="underline"
                      target="_blank"
                    >
                      creativeml-openrail-m
                    </Text>
                  </Text>
                </Group>
              )}
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
            <Stack>
              <Carousel
                slideSize="50%"
                breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
                slideGap="xl"
                align={latestVersion && latestVersion.images.length > 2 ? 'start' : 'center'}
                slidesToScroll={mobile ? 1 : 2}
                withControls={latestVersion && latestVersion.images.length > 2 ? true : false}
                loop
              >
                {latestVersion?.images.map(({ image }) => (
                  <Carousel.Slide key={image.id}>
                    <Center style={{ height: '100%' }}>
                      <ImagePreview
                        image={image}
                        edgeImageProps={{ width: 400 }}
                        // aspectRatio={1}
                        nsfw={nsfw}
                        radius="md"
                        lightboxImages={latestVersion.images.map((x) => x.image)}
                        style={{ width: '100%' }}
                        withMeta
                      />
                    </Center>
                  </Carousel.Slide>
                ))}
              </Carousel>
              {model.description ? (
                <ContentClamp maxHeight={300}>
                  <RenderHtml html={model.description} />
                </ContentClamp>
              ) : null}
            </Stack>
          </Grid.Col>
          <Grid.Col span={12} orderSm={3} my="xl">
            <Stack spacing="xl">
              <Title className={classes.title} order={2}>
                Versions
              </Title>
              <ModelVersions
                items={model.modelVersions}
                initialTab={latestVersion?.id.toString()}
                nsfw={nsfw}
              />
            </Stack>
          </Grid.Col>
          <Grid.Col span={12} orderSm={4} my="xl">
            <Stack spacing="xl">
              <Group sx={{ justifyContent: 'space-between' }}>
                <Stack spacing={4}>
                  <Group spacing={4}>
                    <Title order={3}>Reviews</Title>
                    <ModelRating rank={model.rank} />
                  </Group>
                  <Text
                    size="md"
                    color="dimmed"
                  >{`${model.rank?.ratingCountAllTime.toLocaleString()} total reviews`}</Text>
                </Stack>
                <Stack align="flex-end" spacing="xs">
                  <LoginRedirect reason="create-review">
                    <Button
                      leftIcon={<IconPlus size={16} />}
                      variant="outline"
                      fullWidth={mobile}
                      size="xs"
                      onClick={() => {
                        return openContextModal({
                          modal: 'reviewEdit',
                          title: `Reviewing ${model.name}`,
                          closeOnClickOutside: false,
                          innerProps: {
                            review: {
                              modelId: model.id,
                              modelVersionId:
                                model.modelVersions.length === 1
                                  ? model.modelVersions[0].id
                                  : undefined,
                            },
                          },
                        });
                      }}
                    >
                      Add Review
                    </Button>
                  </LoginRedirect>
                  <Group spacing="xs" noWrap grow>
                    <Select
                      defaultValue={ReviewSort.Newest}
                      icon={<IconArrowsSort size={14} />}
                      data={Object.values(ReviewSort)
                        // Only include Newest and Oldest until reactions are implemented
                        .filter((sort) => [ReviewSort.Newest, ReviewSort.Oldest].includes(sort))
                        .map((sort) => ({
                          label: startCase(sort),
                          value: sort,
                        }))}
                      onChange={handleReviewSortChange}
                      size="xs"
                    />
                    <MultiSelect
                      placeholder="Filters"
                      icon={<IconFilter size={14} />}
                      data={Object.values(ReviewFilter).map((sort) => ({
                        label: startCase(sort),
                        value: sort,
                      }))}
                      onChange={handleReviewFilterChange}
                      size="xs"
                      zIndex={500}
                      clearButtonLabel="Clear review filters"
                      clearable
                    />
                  </Group>
                </Stack>
              </Group>
              <ModelReviews
                items={reviews}
                onFilterChange={handleReviewFilterChange}
                loading={loadingReviews}
              />
              {/* At the bottom to detect infinite scroll */}
              {reviews.length > 0 ? (
                <InView
                  fallbackInView
                  threshold={1}
                  onChange={(inView) => {
                    if (inView && !isFetchingNextPage && hasNextPage) {
                      fetchNextPage();
                    }
                  }}
                >
                  {({ ref }) => (
                    <Button
                      ref={ref}
                      variant="subtle"
                      onClick={() => fetchNextPage()}
                      disabled={!hasNextPage || isFetchingNextPage}
                    >
                      {isFetchingNextPage
                        ? 'Loading more...'
                        : hasNextPage
                        ? 'Load More'
                        : 'Nothing more to load'}
                    </Button>
                  )}
                </InView>
              ) : null}
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
      <Modal
        opened={nsfw}
        onClose={() => router.push('/')}
        centered
        withCloseButton={false}
        padding={30}
      >
        <Stack spacing="xl">
          <Text align="center">The content of this model has been marked NSFW</Text>
          <Group position="center">
            <Button variant="default" onClick={() => router.push('/')}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const [route, queryString] = router.asPath.split('?');
                const query = QS.parse(queryString);
                router.replace(
                  {
                    pathname: route,
                    query: { ...query, showNsfw: true },
                  },
                  router.asPath,
                  {
                    shallow: true,
                  }
                );
              }}
            >
              Click to view NSFW
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
