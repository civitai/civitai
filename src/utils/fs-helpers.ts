import { readdir } from 'fs/promises';

export async function getFilesWithExtension(dir: string, extensions: string[]): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const dirent of dirents) {
    const filePath = `${dir}/${dirent.name}`;
    if (dirent.isFile() && extensions.some((ext) => dirent.name.endsWith(ext))) {
      files.push(filePath);
    } else if (dirent.isDirectory()) {
      files.push(...(await getFilesWithExtension(filePath, extensions)));
    }
  }

  return files;
}
