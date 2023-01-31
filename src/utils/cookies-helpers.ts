import { setCookie as sc } from 'cookies-next';
import dayjs from 'dayjs';

export function setCookie(key: string, data: any) { // eslint-disable-line
  return sc(key, data, {
    expires: dayjs().add(1, 'year').toDate(),
  });
}
