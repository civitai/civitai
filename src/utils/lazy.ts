export async function getJSZip() {
  const JSZip = (await import('jszip')).default;
  return new JSZip();
}
