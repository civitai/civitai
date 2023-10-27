import { PlayFab, PlayFabClient, PlayFabServer } from 'playfab-sdk';
import { promisify } from '~/utils/callback-helpers';

async function ClientLoginWithCustomID(userId: number) {
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabClientModels.LoginResult>>(
    PlayFabClient.LoginWithCustomID,
    {
      CustomId: userId.toString(),
      CreateAccount: true,
      TitleId: PlayFabClient.settings.titleId,
    }
  ).catch((err) => err);
}

async function ServerLinkCustomID(userId: number, playFabId: string) {
  return promisify<
    PlayFabModule.IPlayFabSuccessContainer<PlayFabServerModels.LinkServerCustomIdResult>
  >(PlayFabServer.LinkServerCustomId, {
    ServerCustomId: userId.toString(),
    PlayFabId: playFabId,
    ForceLink: true,
  }).catch((err) => err);
}

async function ServerLoginWithCustomID(userId: number) {
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabServerModels.ServerLoginResult>>(
    PlayFabServer.LoginWithServerCustomId,
    {
      ServerCustomId: userId.toString(),
      CreateAccount: false,
    }
  ).catch((err) => err);
}

export async function LoginWithCustomID(userId: number) {
  let serverLogin = await ServerLoginWithCustomID(userId);
  if (serverLogin.errorCode === 1001) {
    // If server login fails, login with the client and link the accounts
    const clientLogin = await ClientLoginWithCustomID(userId);
    if (clientLogin.errorCode == 1001 || !clientLogin.data.PlayFabId)
      throw new Error('Playfab login failed');

    const serverLink = await ServerLinkCustomID(userId, clientLogin.data.PlayFabId);
    if (serverLink.errorCode) throw new Error('Playfab link failed');
    serverLogin = await ServerLoginWithCustomID(userId);
  }

  return serverLogin;
}

export async function WritePlayerEventClient(
  sessionTicket: string,
  event: PlayFabClientModels.WriteClientPlayerEventRequest
) {
  (PlayFab as any)._internalSettings.sessionTicket = sessionTicket;
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabClientModels.WriteEventResponse>>(
    PlayFabClient.WritePlayerEvent,
    { ...event }
  );
}

export async function WritePlayerEvent(
  playFabId: string,
  event: Omit<PlayFabServerModels.WriteServerPlayerEventRequest, 'PlayFabId'>
) {
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabServerModels.WriteEventResponse>>(
    PlayFabServer.WritePlayerEvent,
    { ...event, PlayFabId: playFabId }
  );
}
