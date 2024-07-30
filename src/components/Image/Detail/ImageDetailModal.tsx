import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { useHotkeys } from '@mantine/hooks';
import { ImageDetailByProps } from '~/components/Image/DetailV2/ImageDetailByProps';
import { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { useRef } from 'react';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export default function ImageDetailModal({
  imageId,
  images,
  hideReactionCount,
}: {
  imageId: number;
  hideReactionCount?: boolean;
  images?: ImagesInfiniteModel[];
} & ImagesContextState) {
  const dialog = useDialogContext();
  const { query } = useBrowserRouter();
  const connectRef = useRef<ConnectProps>();

  const router = useRouter();
  const browserRouter = useBrowserRouter();

  useHotkeys([['Escape', browserRouter.back]]);

  function onNavigate(image: ImagesInfiniteModel) {
    const query = browserRouter.query;
    const [, queryString] = browserRouter.asPath.split('?');

    // prevents updating the url when image detail modals are stacked on top of each other
    if (!dialog.focused) return;

    browserRouter.replace(
      { query: { ...query, imageId: image.id } },
      browserRouter.asPath.startsWith('/images')
        ? {
            pathname: `/images/${image.id}`,
            query: QS.parse(queryString) as any,
          }
        : undefined
    );
  }

  if (!query.imageId) return null;

  if (!connectRef.current) {
    const prevAsPath = browserRouter.state.prev?.asPath ?? router.asPath;
    const pathType = prevAsPath ? getPathType(prevAsPath) : undefined;
    const connect = pathType
      ? getConnectFromPathType(pathType, { ...router.query, ...query })
      : undefined;
    connectRef.current = connect;
  }

  return (
    <PageModal {...dialog} withCloseButton={false} fullScreen padding={0}>
      <ImageDetailByProps
        images={images}
        imageId={imageId}
        onNavigate={onNavigate}
        onClose={browserRouter.back}
        connect={connectRef.current}
      />
    </PageModal>
  );
}

type PathType = keyof typeof pathDir;
const pathDir = {
  bounty: '/bounties',
  model: '/models',
  post: '/posts',
  article: '/articles',
};

function getPathType(path: string) {
  const type = Object.entries(pathDir).find(([key, basePath]) => path.startsWith(basePath))?.[0];
  return type as PathType | undefined;
}

function getConnectFromPathType(pathType: PathType, query: Record<string, any>) {
  const { id, postId } = query;
  const connect: ConnectProps = { connectType: pathType, connectId: id };
  if (pathType === 'post') connect.connectId = postId;
  return connect.connectId ? connect : undefined;
}
