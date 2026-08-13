/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_URL?: string;
  readonly VITE_GATE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
