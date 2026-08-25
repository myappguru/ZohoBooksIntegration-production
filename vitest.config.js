import { defineConfig } from "vitest/config";

// Deliberately its own config, not an extension of vite.config.js - these
// tests only exercise pure functions from .server.js files (payload
// builders, normalizers, key/label helpers), so none of the react-router
// dev-server plugin, HMR, or `server.fs.allow` restrictions in the app's
// own Vite config are relevant here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.js"],
  },
});
