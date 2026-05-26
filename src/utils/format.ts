const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

export function formatNumber(
  value: number | null | undefined,
  fallback = '-',
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? numberFormatter.format(value)
    : fallback;
}

export function formatSpeed(
  value: number | null | undefined,
  fallback = '-',
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${numberFormatter.format(value)} mph`
    : fallback;
}

export function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(value: unknown): string {
  return (
    `${value ?? ''}`
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'race-viewer'
  );
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
