import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const SupportModal = dynamic(() => import('~/components/Support/SupportModal'), {
  ssr: false,
});

const supportDialog = routedDialogDictionary.addItem('support', {
  component: SupportModal,
  resolve: (query) => ({
    query,
    asPath: '/support',
  }),
});

export type SupportDialog = typeof supportDialog;
