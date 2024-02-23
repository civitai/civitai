import { Anchor, Center, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { CommercialUse } from '@prisma/client';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BackButton } from '~/components/BackButton/BackButton';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { numericString } from '~/utils/zod-helpers';
import rehypeRaw from 'rehype-raw';

const querySchema = z.object({ versionId: numericString() });

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };
    if (ssg) await ssg.modelVersion.getLicense.prefetch({ id: result.data.versionId });

    return { props: { versionId: result.data.versionId } };
  },
});

const commercialUsePermissionContent = {
  [CommercialUse.None]: { title: null, content: null },
  [CommercialUse.Image]: {
    title: 'Sell Generated Images',
    content: (
      <Text>
        The following are a few examples of what is prohibited: selling or licensing a product such
        as a game, book, or other work that incorporates or is based on those generated images.
      </Text>
    ),
  },
  [CommercialUse.Rent]: {
    title: 'Use on Other Generation Services',
    content: (
      <Stack spacing={0}>
        <Text>
          Generation Services: use the Model on any service that monetizes image generation. The
          following are a few examples of what is prohibited:
        </Text>
        <Text>
          (a) providing the Model on an as-a-service basis for a fee, whether as a subscription fee,
          per image generation fee, or otherwise; and
        </Text>
        <Text>
          (b) providing the Model as-a-service on a platform that is ad-supported or presents
          advertising.
        </Text>
      </Stack>
    ),
  },
  [CommercialUse.RentCivit]: {
    title: 'Use on Civitai Generation Service',
    content: (
      <Text>
        Civitai Generation Services: run the Model on the Civitai platform (available at{' '}
        <Link href="/generate" passHref>
          <Anchor span>https://civitai.com/generate</Anchor>
        </Link>
        ).
      </Text>
    ),
  },
  [CommercialUse.Sell]: {
    title: 'Sell this Model or merges',
    content: (
      <Text>
        Sale of the Model: sell or license the Model in exchange for a fee or something else of
        value.
      </Text>
    ),
  },
};

export default function ModelLicensePage({
  versionId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data, isLoading } = trpc.modelVersion.getLicense.useQuery({ id: versionId });

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!data) return <NotFound />;

  const hasAdditionalRestrictions =
    data.model.allowNoCredit ||
    data.model.allowDerivatives ||
    data.model.allowDifferentLicense ||
    data.model.allowCommercialUse.length > 0;

  return (
    <>
      <Meta title={`${data.model.name} License`} deIndex="noindex, nofollow" />
      <Container size="md" p="xl">
        <Stack>
          <Group>
            <BackButton url={`/models/${data.model.id}?modelVersionId=${data.id}`} />
            <Title>{data.model.name} License</Title>
          </Group>
          {data.license.content && (
            <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
              {data.license.content}
            </ReactMarkdown>
          )}
          {/* {hasAdditionalRestrictions && (
            <>
              <Text>Attachment B</Text>
              <Text>Additional Restrictions</Text>
              <Text>
                This Attachment B supplements the license to which it is attached
                (&ldquo;License&rdquo;). In addition to any restrictions set forth in the License,
                the following additional terms apply. The below restrictions apply to the Model and
                Derivatives of the Model, even though only the Model is referenced.
                &ldquo;Merge&rdquo; means, with respect to the Model, combining the Model or a
                Derivative of the Model with one or more other models to produce a single model. A
                Derivative of the Model will be understood to include Merges.
              </Text>
              <Text>
                You agree not to do the following with respect to the Model (each a
                &ldquo;Permission&rdquo;):
              </Text>
              {data.model.allowNoCredit && (
                <Text>
                  Creator Credit: to use or distribute the Model you must credit the creator as
                  follows: ...
                </Text>
              )}
              {data.model.allowDerivatives && (
                <Stack spacing={0}>
                  <Text>
                    Share or make available a Merge: The following are a few examples of what is
                    prohibited:
                  </Text>
                  <Text>(a) running an image generation service that uses a Merge; and</Text>
                  <Text>
                    (b) making a Merge available for deployment by another person on an as-a-service
                    basis, download, or otherwise.
                  </Text>
                </Stack>
              )}
              {data.model.allowDifferentLicense && (
                <Text>
                  Changing Permissions: modify or eliminate any of the applicable Permissions when
                  sharing or making available a Derivative of the Model.
                </Text>
              )}
              {data.model.allowCommercialUse.map(
                (permission) => commercialUsePermissionContent[permission]?.content ?? null
              )}
            </>
          )} */}
        </Stack>
      </Container>
    </>
  );
}
