import * as jose from 'jose';
import { env } from 'process';

const alg = 'HS256';
const secret = new TextEncoder().encode(env.CANNY_SECRET);

export async function createCannyToken({
  image,
  email,
  username,
  id,
}: {
  image: string | null;
  email: string | null;
  username: string | null;
  id: number;
}) {
  if (!env.CANNY_SECRET) return;

  const userData = {
    avatarUrl: image,
    email: email,
    name: username,
    id: id,
  };

  return await new jose.SignJWT(userData)
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setIssuer('canny')
    .setAudience('canny')
    .sign(secret);
}
