import type { MediaAttachment, MediaVariant } from '../../types';
import { escapeHtml } from '../../utils/format';

export const MAX_MEDIA_ATTACHMENTS = 4;

const VARIANT_PREFERENCE = ['large', 'medium', 'thumb'];

export function readMediaBaseUrl(): string {
  const value = import.meta.env.VITE_MEDIA_BASE_URL;
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

export function parseMediaAttachments(value: unknown): MediaAttachment[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map(normalizeMediaAttachment)
    .filter((item): item is MediaAttachment => Boolean(item))
    .slice(0, MAX_MEDIA_ATTACHMENTS);
}

export function serializeMediaAttachments(
  attachments: MediaAttachment[],
): string {
  return JSON.stringify(
    attachments
      .map(normalizeMediaAttachment)
      .filter((item): item is MediaAttachment => Boolean(item))
      .slice(0, MAX_MEDIA_ATTACHMENTS),
  );
}

export function normalizeMediaJson(value: unknown): string {
  return serializeMediaAttachments(parseMediaAttachments(value));
}

export function renderMediaAttachmentEditor(
  mediaJson: unknown,
  canUpload: boolean,
): string {
  const attachments = parseMediaAttachments(mediaJson);
  return `
    <section class="media-attachment-editor" data-media-editor>
      <input type="hidden" name="media_json" value="${escapeHtml(serializeMediaAttachments(attachments))}" />
      <div class="media-attachment-list" data-media-list>
        ${renderMediaAttachmentEditorList(attachments)}
      </div>
      ${
        canUpload
          ? `<label class="button ghost media-upload-button" ${attachments.length >= MAX_MEDIA_ATTACHMENTS ? 'hidden' : ''}>
              <span>Add Images</span>
              <input data-action="media-upload" type="file" accept="image/png,image/jpeg,image/webp" multiple />
            </label>`
          : '<p class="annotation-meta">Connect cloud sync with media upload access to add images.</p>'
      }
      ${canUpload ? `<p class="annotation-meta" data-media-limit ${attachments.length < MAX_MEDIA_ATTACHMENTS ? 'hidden' : ''}>Image limit reached.</p>` : ''}
      <p class="annotation-meta media-upload-status" data-media-status></p>
    </section>
  `;
}

export function renderMediaAttachmentGallery(mediaJson: unknown): string {
  const attachments = parseMediaAttachments(mediaJson);
  if (!attachments.length) {
    return '';
  }

  return `
    <div class="media-attachment-gallery">
      ${attachments
        .map((attachment) => {
          const thumbUrl = mediaAttachmentUrl(attachment, 'thumb');
          const largeUrl = mediaAttachmentUrl(attachment, 'large');
          if (!thumbUrl) {
            return '';
          }
          const altText =
            attachment.altText ||
            attachment.caption ||
            attachment.originalFileName ||
            'Uploaded race image';
          return `
            <a class="media-attachment-thumb" href="${escapeHtml(largeUrl || thumbUrl)}" target="_blank" rel="noreferrer">
              <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(altText)}" loading="lazy" />
              ${attachment.caption ? `<span>${escapeHtml(attachment.caption)}</span>` : ''}
            </a>
          `;
        })
        .join('')}
    </div>
  `;
}

export function getFormMediaAttachments(
  form: HTMLFormElement,
): MediaAttachment[] {
  const field = form.elements.namedItem('media_json');
  return parseMediaAttachments(
    field instanceof HTMLInputElement ? field.value : '[]',
  );
}

export function setFormMediaAttachments(
  form: HTMLFormElement,
  attachments: MediaAttachment[],
  canUpload: boolean,
): void {
  const normalized = parseMediaAttachments(
    serializeMediaAttachments(attachments),
  );
  const field = form.elements.namedItem('media_json');
  if (field instanceof HTMLInputElement) {
    field.value = serializeMediaAttachments(normalized);
  }

  const list = form.querySelector<HTMLElement>('[data-media-list]');
  if (list) {
    list.innerHTML = renderMediaAttachmentEditorList(normalized);
  }

  const uploadButton = form.querySelector<HTMLElement>('.media-upload-button');
  if (uploadButton) {
    uploadButton.hidden =
      !canUpload || normalized.length >= MAX_MEDIA_ATTACHMENTS;
  }

  const limitMessage = form.querySelector<HTMLElement>('[data-media-limit]');
  if (limitMessage) {
    limitMessage.hidden =
      !canUpload || normalized.length < MAX_MEDIA_ATTACHMENTS;
  }
}

export function updateFormMediaAttachmentText(
  form: HTMLFormElement,
  assetId: string,
  field: 'caption' | 'altText',
  value: string,
): void {
  const attachments = getFormMediaAttachments(form).map((attachment) =>
    attachment.assetId === assetId
      ? { ...attachment, [field]: value.slice(0, 240) }
      : attachment,
  );
  const hidden = form.elements.namedItem('media_json');
  if (hidden instanceof HTMLInputElement) {
    hidden.value = serializeMediaAttachments(attachments);
  }
}

function renderMediaAttachmentEditorList(
  attachments: MediaAttachment[],
): string {
  if (!attachments.length) {
    return '<p class="annotation-meta">No images attached.</p>';
  }

  return attachments
    .map((attachment) => {
      const thumbUrl = mediaAttachmentUrl(attachment, 'thumb');
      return `
        <article class="media-attachment-editor-item" data-asset-id="${escapeHtml(attachment.assetId)}">
          ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />` : ''}
          <div class="media-attachment-fields">
            <label><span>Caption</span><input data-action="media-caption" data-asset-id="${escapeHtml(attachment.assetId)}" value="${escapeHtml(attachment.caption)}" /></label>
            <label><span>Alt Text</span><input data-action="media-alt" data-asset-id="${escapeHtml(attachment.assetId)}" value="${escapeHtml(attachment.altText)}" /></label>
            <button class="button ghost" data-action="detach-media" data-asset-id="${escapeHtml(attachment.assetId)}" type="button">Detach</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function mediaAttachmentUrl(
  attachment: MediaAttachment,
  preferredName: string,
): string {
  const baseUrl = readMediaBaseUrl();
  if (!baseUrl) {
    return '';
  }

  const variant = pickVariant(attachment.variants, preferredName);
  return variant?.objectKey
    ? `${baseUrl}/${variant.objectKey.replace(/^\/+/, '')}`
    : '';
}

function pickVariant(
  variants: MediaVariant[],
  preferredName: string,
): MediaVariant | null {
  return (
    variants.find((variant) => variant.name === preferredName) ||
    VARIANT_PREFERENCE.map((name) =>
      variants.find((variant) => variant.name === name),
    ).find((variant): variant is MediaVariant => Boolean(variant)) ||
    variants[0] ||
    null
  );
}

function normalizeMediaAttachment(value: unknown): MediaAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Record<string, unknown>;
  const assetId = stringValue(item.assetId);
  const variants = Array.isArray(item.variants)
    ? item.variants.map(normalizeMediaVariant).filter(Boolean)
    : [];
  if (!assetId || !variants.length) {
    return null;
  }

  return {
    assetId,
    originalFileName: stringValue(item.originalFileName),
    sourceSha256: stringValue(item.sourceSha256),
    createdBy: stringValue(item.createdBy),
    createdAt: stringValue(item.createdAt),
    caption: stringValue(item.caption),
    altText: stringValue(item.altText),
    variants: variants as MediaVariant[],
  };
}

function normalizeMediaVariant(value: unknown): MediaVariant | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Record<string, unknown>;
  const objectKey = stringValue(item.objectKey);
  if (!objectKey) {
    return null;
  }

  return {
    name: stringValue(item.name),
    objectKey,
    width: numberValue(item.width),
    height: numberValue(item.height),
    byteSize: numberValue(item.byteSize),
    contentType: stringValue(item.contentType),
  };
}

function parseJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}
