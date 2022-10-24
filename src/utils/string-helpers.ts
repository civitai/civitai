export function splitUppercase(value: string) {
  return value.split(/(?=[A-Z])/).join(' ');
}
