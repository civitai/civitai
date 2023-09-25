import { setCookie as sc, deleteCookie } from 'cookies-next';
import dayjs from 'dayjs';

export function setCookie(key: string, data: any, expires?: Date) { // eslint-disable-line
  return sc(key, data, {
    expires: expires || dayjs().add(1, 'year').toDate(),
  });
}
export function deleteCookies(keys: string[]) {
  keys.forEach((key) => deleteCookie(key));
  return;
}
