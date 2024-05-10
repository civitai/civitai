import {
  ActionIcon,
  Box,
  Button,
  Card,
  CloseButton,
  createStyles,
  Divider,
  Group,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { Availability, CollectionType } from '@prisma/client';
import {
  IconAlertTriangle,
  IconBookmark,
  IconDotsVertical,
  IconEye,
  IconFlag,
} from '@tabler/icons-react';
import { adsRegistry } from '~/components/Ads/adsRegistry';
import { Adunit } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { TrackView } from '~/components/TrackView/TrackView';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { env } from '~/env/client.mjs';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ProfileBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';

export function ImageDetail2() {
  const { image: image, isLoading, active, close, toggleInfo } = useImageDetailContext();
  const { query } = useBrowserRouter();

  if (isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);

  return (
    <div className="h-full w-full flex max-h-full max-w-full">
      <ImageDetailCarousel />
    </div>
  );
}
