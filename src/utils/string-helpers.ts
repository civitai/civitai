export function splitUppercase(value: string) {
  return value.split(/(?=[A-Z])/).join(' ');
}

export function getInitials(value: string) {
  return value
    .match(/(^\S\S?|\b\S)?/g)
    ?.join('')
    .match(/(^\S|\S$)?/g)
    ?.join('')
    .toUpperCase();
}

const tokenCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const tokenCharactersLength = tokenCharacters.length;
export function generateToken(length: number) {
  let result = '';
  for (let i = 0; i < length; i++)
    result += tokenCharacters.charAt(Math.floor(Math.random() * tokenCharactersLength));
  return result;
}
