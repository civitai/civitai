import { OAuth2Client } from 'google-auth-library';
import { google, youtube_v3 } from 'googleapis';
import { env } from '~/env/server.mjs';

const OAuth2 = google.auth.OAuth2;

const getClient = () => {
  if (!env.YOUTUBE_APP_CLIENT_ID || !env.YOUTUBE_APP_CLIENT_SECRET) {
    throw new Error('Missing YouTube client ID or secret');
  }

  const oauth2Client = new OAuth2({
    clientId: env.YOUTUBE_APP_CLIENT_ID,
    clientSecret: env.YOUTUBE_APP_CLIENT_SECRET,
  });

  return oauth2Client;
};

export const getYoutubeAuthUrl = ({
  redirectUri,
  ...state
}: {
  redirectUri: string;
} & MixedObject) => {
  const client = getClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.upload',
    ],
    state: JSON.stringify(state),
    redirect_uri: `${env.NEXT_PUBLIC_BASE_URL}${redirectUri}`,
    include_granted_scopes: true,
  });
};

export const getYoutubeRefreshToken = async (code: string, redirectUri: string) => {
  const client = getClient();

  const token = await client.getToken({
    code: code,
    // Required since we get the authUrl with a redirectUri.
    // Must match the redirectUri used to get the tokens
    redirect_uri: `${env.NEXT_PUBLIC_BASE_URL}${redirectUri}`,
  });

  return token;
};

export const getYoutubeAuthClient = async (refreshToken: string) => {
  const client = getClient();
  client.setCredentials({ refresh_token: refreshToken });

  return client;
};

export const getYoutubeVideos = (client: OAuth2Client) => {
  return new Promise<youtube_v3.Schema$VideoListResponse | null | undefined>((resolve, reject) => {
    const service = google.youtube('v3');
    service.videos.list(
      {
        auth: client,
        part: ['snippet', 'contentDetails', 'statistics'],
        chart: 'mostPopular',
      },
      (err, response) => {
        if (err) {
          console.error('The API returned an error: ' + err);
          reject(err);
          return;
        }

        resolve(response?.data);
      }
    );
  });
};
