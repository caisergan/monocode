// The package type-checks with only the ES library, so the few host globals
// it uses are declared here. Node and Hermes both provide them.
declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
