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
