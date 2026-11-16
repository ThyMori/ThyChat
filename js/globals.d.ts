// Variables posées sur `window` par index.html et app.ts (démarrage et diagnostic).
export {};

declare global {
  interface Window {
    __initialHash?: string;
    __booted?: boolean;
    __step?: string;
    __lastError?: string;
    __showLoadingError: () => void;
  }
}
