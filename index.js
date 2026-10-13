import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRouter, loadConfig } from "./router.js";

export default function autoRouter(pi) {
  pi.registerFlag("auto-router-config", {
    type: "string",
    description: "Path to pi-auto-router JSON configuration",
  });
  // Pi applies CLI flag values after factories; model IDs must exist before selection.
  const cliPath = parseArgs({
    args: process.argv.slice(2),
    options: { "auto-router-config": { type: "string" } },
    strict: false,
    allowPositionals: true,
  }).values["auto-router-config"];
  const configuredPath = pi.getFlag("auto-router-config") || cliPath || process.env.PI_AUTO_ROUTER_CONFIG;
  const path = configuredPath
    ? resolve(configuredPath.startsWith("~/") ? resolve(homedir(), configuredPath.slice(2)) : configuredPath)
    : resolve(process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent"), "autorouter.json");
  const config = loadConfig(path);
  for (const [id, settings] of Object.entries(config.models)) {
    pi.registerVirtualModel({
      provider: "autorouter",
      id,
      name: `Auto Router (${id})`,
      thinkingLevels: ["off"],
      route: createRouter(settings),
    });
  }
}
