import { ActionIcon, Modal } from '@mantine/core';
import Router from 'next/router';
import { getCookie, setCookie } from 'cookies-next';
import { useEffect } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { IconCircleX } from '@tabler/icons-react';

const timeframe = [1711983600000, 1712030400000];
function handleNavigate() {
  const count = Number(getCookie('chadgpt') ?? 0) + 1;
  if (count <= 3) setCookie('chadgpt', count);
  if (count === 3) {
    setTimeout(() => dialogStore.trigger({ id: 'chadgpt', component: ChadGPTModal }), 1000);
  }
}

export default function ChadGPT({ isAuthed }: { isAuthed: boolean }) {
  useEffect(() => {
    if (typeof window === 'undefined' || !isAuthed) return;
    const isTime = Date.now() > timeframe[0] && Date.now() < timeframe[1];
    if (!isTime) return;

    Router.events.on('routeChangeComplete', handleNavigate);

    return () => {
      Router.events.off('routeChangeComplete', handleNavigate);
    };
  }, []);
  return null;
}

function ChadGPTModal() {
  const dialog = useDialogContext();

  return (
    <Modal
      {...dialog}
      fullScreen
      withCloseButton={false}
      closeOnEscape
      styles={{
        modal: { padding: '0 !important', backgroundColor: 'transparent' },
        body: { height: '100%' },
      }}
    >
      <iframe
        src="https://community-content.civitai.com/chadgpt.html"
        title="ChadGPT"
        style={{
          width: '100%',
          height: '100%',
          border: 0,
          visibility: 'hidden',
        }}
        onLoad={(event) => {
          const iframe = event.target as HTMLIFrameElement;
          iframe.style.visibility = 'visible';
        }}
      />
      <ActionIcon
        size={48}
        variant="transparent"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          opacity: 0,
          animation: '1s fadeIn 8s linear forwards',
          outline: 'none',
        }}
        onClick={() => dialogStore.closeById('chadgpt')}
      >
        <IconCircleX size={48} strokeWidth={1} />
      </ActionIcon>
    </Modal>
  );
}
