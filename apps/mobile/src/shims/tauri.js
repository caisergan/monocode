// The desktop session model reaches Tauri modules through helpers the phone
// never calls (src/platform/tauri/fs.ts). Metro resolves every @tauri-apps
// import here; calling anything fails loudly instead of silently.
module.exports = new Proxy(
  {},
  {
    get(_target, name) {
      if (name === "__esModule") return true;
      return () => {
        throw new Error(`Tauri API ${String(name)} is not available on the phone`);
      };
    },
  },
);
