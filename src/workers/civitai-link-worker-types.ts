import { CivitaiLinkInstance } from '~/components/CivitaiLink/civitai-link-api';
import {
  ActivitiesResponse,
  Command,
  ResponseResourcesList,
  Response,
} from '~/components/CivitaiLink/shared-types';

export type Instance = {
  id: number | null;
  name: string | null;
  key: string | null;
  connected: boolean; // general connection status - aggregate of `clientsConnected` and `sdConnected`
  clientsConnected: number; // number of people in room, even though it's probably just you
  sdConnected: boolean; // if the sd instance is available to connect to
};

export type WorkerOutgoingMessage =
  | { type: 'ready' }
  | { type: 'socketConnection'; payload: boolean }
  | { type: 'error'; msg: string }
  | { type: 'message'; msg: string }
  | { type: 'activitiesUpdate'; payload: ActivitiesResponse[] }
  | { type: 'instancesUpdate'; payload: CivitaiLinkInstance[] | undefined }
  | { type: 'resourcesUpdate'; payload: ResponseResourcesList['resources'] }
  | { type: 'commandComplete'; payload: Response }
  | { type: 'instance'; payload: Instance };

export type WorkerIncomingMessage =
  | { type: 'create'; id?: number }
  | { type: 'delete'; id: number }
  | { type: 'rename'; id: number; name: string }
  | { type: 'join'; id: number }
  | { type: 'leave' }
  | { type: 'command'; payload: Command };
