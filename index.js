import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter, loadConfig } from "./router.js";

export default function autoRouter(pi) {
  pi.registerFlag("auto-router-config", {
    type: "string",
    description: "Path to pi-auto-router JSON configuration",
  });
  let route;
  pi.registerVirtualModel({
    provider: "auto-router",
    id: "auto",
    name: "Auto Router",
    thinkingLevels: ["off"],
    route(request, ctx) {
      // Pi parses extension CLI flags after factories run; read them on first dispatch.
      if (!route) {
        const configuredPath = pi.getFlag("auto-router-config") || process.env.PI_AUTO_ROUTER_CONFIG;
        const path = configuredPath
          ? resolve(configuredPath.startsWith("~/") ? resolve(homedir(), configuredPath.slice(2)) : configuredPath)
          : fileURLToPath(new URL("./config.json", import.meta.url));
        route = createRouter(loadConfig(path));
      }
      return route(request, ctx);
    },
  });
}
