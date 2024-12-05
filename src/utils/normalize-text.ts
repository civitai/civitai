let heInitialized = false;
const he: { decode: (str: string) => string } = { decode: (str: string) => str };
function getHe() {
  if (!heInitialized) {
    heInitialized = true;
    import('he').then((x) => {
      he.decode = x.decode;
    });
  }

  return he;
}

export function normalizeText(input?: string): string {
  if (!input) return '';
  let result = input;
  if (input.includes('&')) result = getHe().decode(input);
  return result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
