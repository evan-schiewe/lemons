export async function loadCsvFiles(fileList) {
  const files = Array.from(fileList ?? []);
  const loadedFiles = [];

  for (const file of files) {
    loadedFiles.push(await loadCsvFile(file));
  }

  return loadedFiles;
}

export async function loadCsvFile(file) {
  const text = await file.text();
  const contentHash = await hashText(text);

  return {
    file,
    fileName: file.name,
    raceName: inferRaceName(file.name),
    text,
    contentHash,
  };
}

export function inferRaceName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
