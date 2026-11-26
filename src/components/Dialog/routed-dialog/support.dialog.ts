import type SupportModal from '~/components/Support/SupportModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const supportDialog = routedDialog<typeof SupportModal>({
  resolve: (query) => ({
    query,
    asPath: '/support',
  }),
});
