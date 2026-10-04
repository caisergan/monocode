// Types for desktop modules type-checked through @monocode/core.
declare module "*?raw" {
  const text: string;
  export default text;
}
interface ImportMeta {
  hot?: { dispose(callback: () => void): void };
}
