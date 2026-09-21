import { Container } from '@mantine/core';
import { Page } from '~/components/AppLayout/Page';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import { HubsLanding } from '~/components/Hubs/HubsLanding';
import { hubUrl, LAST_HUB_COOKIE } from '~/components/Hubs/hub.utils';
import { Meta } from '~/components/Meta/Meta';
import { getUserHubs } from '~/server/services/user-hub.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    if (!features?.userHubs) return { notFound: true };
    if (!session?.user) return;

    // `?all` is how anyone reaches this page past the redirects below — for the
    // templates and the explainer. The sidebar's header links here with it.
    if (ctx.query.all !== undefined) return;

    const hubs = await getUserHubs({ userId: session.user.id });
    if (!hubs.length) return;

    // One hub is not a choice to be offered: its owner came here to read it. With
    // several, the hub they last opened is the better guess than this page — and
    // matched against their OWN hubs, so a stale or borrowed cookie falls through to
    // the page rather than redirecting anywhere.
    const lastViewed = hubs.find((hub) => hub.key === ctx.req.cookies[LAST_HUB_COOKIE]);
    const destination = hubs.length === 1 ? hubs[0] : lastViewed;
    if (destination) return { redirect: { destination: hubUrl(destination), permanent: false } };
  },
});

export default Page(
  function HubsPage() {
    return (
      <>
        <Meta title="Hubs | Civitai" deIndex />
        <Container size="lg" py="md">
          <HubsLanding />
        </Container>
      </>
    );
  },
  { InnerLayout: HubsLayout }
);
