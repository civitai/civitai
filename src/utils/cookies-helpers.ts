import { setCookie as sc, deleteCookie } from 'cookies-next';

export function setCookie(key: string, data: any, expires?: Date) { // eslint-disable-line
  const d = new Date();
  return sc(key, data, {
    expires: expires || new Date(d.setFullYear(d.getFullYear() + 1)),
  });
}
export function deleteCookies(keys: string[]) {
  keys.forEach((key) => deleteCookie(key));
  return;
}
