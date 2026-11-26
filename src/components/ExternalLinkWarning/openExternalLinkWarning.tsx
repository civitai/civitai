import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';
import {
  ExternalLinkWarningBody,
  ExternalLinkWarningTitle,
} from '~/components/ExternalLinkWarning/ExternalLinkWarning';

/**
 * 🔴 `noopener` is not cosmetic here: without it the destination gets a live `window.opener`
 * handle back to the Civitai tab and can navigate it.
 */
export function openExternalLinkWarning(href: string) {
  openConfirm({
    title: <ExternalLinkWarningTitle />,
    labels: { cancel: 'Cancel', confirm: 'Continue' },
    message: <ExternalLinkWarningBody href={href} />,
    onConfirm: () => {
      window.open(href, '_blank', 'noopener,noreferrer');
    },
  });
}
