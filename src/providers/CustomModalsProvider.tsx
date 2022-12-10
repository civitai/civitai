import {
  closeAllModals,
  ContextModalProps,
  ModalsProvider as MantineModalsProvider,
  openContextModal,
} from '@mantine/modals';
import { OpenContextModal } from '@mantine/modals/lib/context';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, createContext, useContext } from 'react';
import { QS } from '~/utils/qs';

const DynamicReviewEditModal = dynamic(() => import('~/components/Review/ReviewEditModal'));
const DynamicCommentEditModal = dynamic(
  () => import('~/components/CommentEditModal/CommentEditModal')
);
const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);
const DynamicLightboxImageCarousel = dynamic(
  () => import('~/components/LightboxImageCarousel/LightboxImageCarousel')
);
const DynamicCommentThreadModal = dynamic(
  () => import('~/components/CommentThreadModal/CommentThreadModal')
);
const DynamicReviewThreadModal = dynamic(
  () => import('~/components/ReviewThreadModal/ReviewThreadModal')
);

const DynamicRunStrategyModal = dynamic(() => import('~/components/RunStrategy/RunStrategyModal'));

const modals = {
  reviewEdit: DynamicReviewEditModal,
  imageLightbox: DynamicLightboxImageCarousel,
  onboarding: DynamicOnboardingModal,
  commentEdit: DynamicCommentEditModal,
  commentThread: DynamicCommentThreadModal,
  reviewThread: DynamicReviewThreadModal,
  runStrategy: DynamicRunStrategyModal,
};

type OpenContextModalProps<CustomProps extends Record<string, unknown>> =
  OpenContextModal<CustomProps> & { modal: keyof typeof modals };
type ModalContext = {
  openModal: <CustomProps extends Record<string, unknown>>({
    modal,
    ...props
  }: OpenContextModalProps<CustomProps>) => void;
};

const ModalCtx = createContext<ModalContext>({} as ModalContext);
export const useModalsContext = () => {
  const context = useContext(ModalCtx);
  if (!context) throw new Error('useModalsContext can only be used inside CustomModalsProvider');

  return context;
};

export const CustomModalsProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();

  useEffect(() => {
    const { modal, ...query } = router.query;
    if (modal) router.replace({ query }, undefined, { shallow: true });
  }, []); //eslint-disable-line

  useEffect(() => {
    router.beforePopState(({ as }) => {
      if (as !== router.asPath && router.query.modal !== undefined) {
        closeAllModals();
        const [asPathname, asQuery] = as.split('?');
        router.replace(
          { pathname: asPathname, query: { ...router.query, ...QS.parse(asQuery) } as any },
          as,
          { shallow: true }
        );
        return false;
      }
      return true;
    });

    return () => router.beforePopState(() => true);
  }, [router]);

  const openModal = useCallback(
    <CustomProps extends Record<string, unknown>>({
      modal,
      onClose,
      ...payload
    }: OpenContextModalProps<CustomProps>) => {
      const [pathname, visibleQuery] = router.asPath.split('?');
      const asQuery = { ...QS.parse(visibleQuery), modal: modal };
      router.push(
        { pathname, query: { ...router.query, modal: modal } },
        { pathname, query: asQuery },
        { shallow: true }
      );
      openContextModal({
        modal,
        onClose: () => {
          if (window.location.search.includes(`modal=${modal}`)) {
            router.back();
          }
          onClose?.();
        },
        ...payload,
      });
    },
    [router]
  );

  return (
    <MantineModalsProvider
      labels={{
        confirm: 'Confirm',
        cancel: 'Cancel',
      }}
      modals={modals as Record<string, React.FC<ContextModalProps<any>>>}
    >
      <ModalCtx.Provider value={{ openModal }}>{children}</ModalCtx.Provider>
    </MantineModalsProvider>
  );
};
