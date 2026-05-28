import type { MediaVariantName } from '../../types';

export interface PreparedMediaVariant {
  name: MediaVariantName;
  file: File;
  width: number;
  height: number;
}

export interface PreparedMediaUpload {
  assetId: string;
  originalFileName: string;
  sourceSha256: string;
  variants: PreparedMediaVariant[];
}

const VARIANT_TARGETS: Array<{ name: MediaVariantName; maxWidth: number }> = [
  { name: 'thumb', maxWidth: 320 },
  { name: 'medium', maxWidth: 800 },
  { name: 'large', maxWidth: 1600 },
];

export async function prepareMediaUpload(
  file: File,
  assetId: string = crypto.randomUUID(),
): Promise<PreparedMediaUpload> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files can be uploaded.');
  }

  const originalBytes = await file.arrayBuffer();
  const sourceSha256 = await sha256Hex(originalBytes);
  const source = await decodeImage(file);

  try {
    const variants = [];
    for (const target of VARIANT_TARGETS) {
      variants.push(await createVariant(file.name, source, target));
    }

    return {
      assetId,
      originalFileName: file.name,
      sourceSha256,
      variants,
    };
  } finally {
    if ('close' in source.image && typeof source.image.close === 'function') {
      source.image.close();
    }
  }
}

async function createVariant(
  fileName: string,
  source: DecodedImage,
  target: { name: MediaVariantName; maxWidth: number },
): Promise<PreparedMediaVariant> {
  const scale = Math.min(1, target.maxWidth / source.width);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser cannot resize images.');
  }

  context.drawImage(source.image, 0, 0, width, height);

  const webp = await canvasToBlob(canvas, 'image/webp', 0.84);
  const blob =
    webp && webp.type === 'image/webp'
      ? webp
      : await canvasToBlob(canvas, 'image/jpeg', 0.86);
  if (!blob) {
    throw new Error('This browser cannot encode resized images.');
  }

  const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return {
    name: target.name,
    file: new File(
      [blob],
      `${stripExtension(fileName)}-${target.name}.${extension}`,
      {
        type: blob.type,
      },
    ),
    width,
    height,
  };
}

interface DecodedImage {
  image: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if ('createImageBitmap' in window) {
    try {
      const image = await createImageBitmap(file);
      return {
        image,
        width: image.width,
        height: image.height,
      };
    } catch {
      // Fall through to HTMLImageElement decoding.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || 'image';
}
