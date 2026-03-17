import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const workspaceRoot = resolve(currentDir, "..");

function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readClientPort(clientOrigin) {
  try {
    const url = new URL(clientOrigin);
    return readPort(
      url.port,
      url.protocol === "https:" ? 443 : 80,
    );
  } catch {
    return 5173;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const clientOrigin = env.CLIENT_ORIGIN?.trim() || "http://localhost:5173";
  const serverPort = readPort(env.SERVER_PORT, 3001);

  return {
    envDir: workspaceRoot,
    plugins: [react()],
    server: {
      port: readClientPort(clientOrigin),
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
