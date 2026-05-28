import { copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await copyFile(
  resolve(root, 'dist/index.html'),
  resolve(root, 'dist/404.html'),
);
