/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_API_BASE?: string;
  readonly VITE_SYNC_PUBLIC_READ_TOKEN?: string;
  readonly VITE_SYNC_READ_ONLY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
