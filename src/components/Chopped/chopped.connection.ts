import { io } from 'socket.io-client';
import type { JoinGame, NewGame, SocketClient } from './chopped.shared-types';
import { env } from '~/env/client';
import type { Difference } from '~/utils/object-helpers';
import { useChoppedStore } from '~/components/Chopped/chopped.utils';
import { showNotification } from '@mantine/notifications';
import { useEffect } from 'react';

const DISABLED = false;

// --------------------------------
// Setup Socket
// --------------------------------
const socket: SocketClient = io(env.NEXT_PUBLIC_CHOPPED_ENDPOINT!, {
  path: '/socketio',
  autoConnect: false,
});

// --------------------------------
// Get Store References
// --------------------------------
// const storeOld = useChoppedStore((state) => ({
//   patchGame: state.patchGame,
//   setGame: state.setGame,
//   setGlobal: state.setGlobal,
//   setUserId: state.setUserId,
// }));

// This may cause issues because it might have all the state
// TODO.chopped - consider putting base64s in separate state
const store = useChoppedStore.getState();

// --------------------------------
// Handle Socket Events
// --------------------------------
socket
  .on('connect', () => {
    if (DISABLED) return;

    const token = localStorage.getItem('chopped-token');
    if (!token) return;

    socket.emit('reconnect', token);
  })
  .on('disconnect', () => undefined)
  .on('updateGlobal', (global) => {
    console.log(`socket.on('updateGlobal')`, global);
    store.setGlobal(global);
  })
  .on('updateGame', (game) => {
    console.log(`socket.on('updateGame')`, game.code);
    store.setGame(game);
  })
  .on('patchGame', (patch: Difference[]) => {
    console.log(`socket.on('patchGame')`, patch);
    store.patchGame(patch);
  })
  .on('setUserId', ({ userId, token }) => {
    console.log(`socket.on('setUserId')`, userId);
    localStorage.setItem('chopped-token', token);
    store.setUserId(userId);
  })
  .on('message', (msg) => {
    console.log(`socket.on('message')`, msg);
    showNotification({ id: msg, message: msg, title: 'Civitai Chopped', color: 'blue' });
  })
  .on('error', (msg) => {
    console.error(`socket.on('error')`, msg);
    showNotification({ id: msg, message: msg, title: 'Civitai Chopped - Error', color: 'red' });
  })
  .on('kicked', () => {
    console.error(`socket.on('kicked')`);
    showNotification({
      id: 'kicked',
      message: 'You have been kicked from the game',
      title: 'Civitai Chopped',
      color: 'red',
    });
    store.setUserId(undefined);
    store.setGame(undefined);
  });

// --------------------------------
// Helper Functions
// --------------------------------
function confirmConnection() {
  if (socket.connected) return;
  try {
    socket.connect();
  } catch (error) {
    showNotification({
      id: 'disconnected',
      message: 'You are not connected to the server',
      title: 'Civitai Chopped',
      color: 'red',
    });
    throw new Error('Not connected to server');
  }
}
function notifyCallback(res: { success: boolean; msg?: string }) {
  if (!res.msg) return;
  showNotification({
    id: 'callback',
    message: res.msg,
    title: 'Civitai Chopped',
    color: !res.success ? 'red' : 'blue',
  });
}

// --------------------------------
// Create Socket Commands
// --------------------------------
function createGame(req: NewGame) {
  confirmConnection();
  socket.emit('new', req, (res) => {
    console.log(`socket.emit('new')`, res);
    notifyCallback(res);
  });
}
function join(req: JoinGame) {
  confirmConnection();
  socket.emit('join', req, (res) => {
    console.log(`socket.emit('join')`, res);
    notifyCallback(res);
  });
}
function leave() {
  confirmConnection();
  socket.emit('leave');
  console.log(`socket.emit('leave')`);
  store.setGame(undefined);
  store.setUserId(undefined);
  localStorage.removeItem('chopped-token');
}
function retry() {
  confirmConnection();
  socket.emit('retry');
  console.log(`socket.emit('retry')`);
}
function continueGame() {
  confirmConnection();
  socket.emit('continue', (res) => {
    console.log(`socket.emit('continue')`, res);
    notifyCallback(res);
  });
}
function submitImage(image: string) {
  confirmConnection();
  socket.emit('submit', image, (res) => {
    console.log(`socket.emit('submit')`, res);
    notifyCallback(res);
  });
}
function gameAgain() {
  confirmConnection();
  socket.emit('gameAgain');
}

// --------------------------------
// Hook
// --------------------------------
const SOCKET_TIMEOUT = 1000 * 60 * 10; // 10 minutes
let timeout: NodeJS.Timeout | undefined = undefined;
let openReferences = 0;
export const useChoppedServer = () => {
  useEffect(() => {
    if (timeout) clearTimeout(timeout); // Clear timeout if it exists
    if (!socket.connected) socket.connect();

    openReferences++;
    return () => {
      // Check for references
      openReferences--;
      if (openReferences !== 0) return;

      // If no more references, disconnect after timeout
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        socket.disconnect();
      }, SOCKET_TIMEOUT);
    };
  }, []);

  return {
    createGame,
    join,
    leave,
    retry,
    continueGame,
    submitImage,
    gameAgain,
  };
};
