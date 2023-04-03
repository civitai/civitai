import { PlayFab, PlayFabClient } from 'playfab-sdk';
import { promisify } from '~/utils/callback-helpers';

export async function LoginWithCustomID(userId: number) {
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabClientModels.LoginResult>>(
    PlayFabClient.LoginWithCustomID,
    {
      CustomId: userId.toString(),
      CreateAccount: true,
      TitleId: PlayFabClient.settings.titleId,
    }
  );
}

export async function WritePlayerEvent(
  sessionTicket: string,
  event: PlayFabClientModels.WriteClientPlayerEventRequest
) {
  (PlayFab as any)._internalSettings.sessionTicket = sessionTicket;
  return promisify<PlayFabModule.IPlayFabSuccessContainer<PlayFabClientModels.WriteEventResponse>>(
    PlayFabClient.WritePlayerEvent,
    { ...event }
  );
}
