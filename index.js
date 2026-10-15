import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATEGORIES, createRouter, getRoutingMode, loadConfig, parseTierPrefix, setRoutingMode, setRouterStatus } from "./router.js";

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
      route: createRouter(settings, pi, id),
    });
  }
  function refreshStatus(event, ctx) {
    const id = ctx.model?.id;
    if (ctx.model?.provider !== "autorouter" || !Object.hasOwn(config.models, id)) {
      ctx.ui.setStatus("pi-auto-router", undefined);
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", undefined);
      return;
    }
    const mode = getRoutingMode(ctx, id);
    setRouterStatus(ctx, mode);
    if (ctx.hasUI && (event.type === "session_start" ||
      (event.type === "model_select" && event.source !== "restore" && event.previousModel?.provider !== "autorouter"))) {
      const hint = `Auto router: ${["auto", ...CATEGORIES].map((mode) => `:${mode}`).join(" ")} — prefix a prompt or send alone (sticky).`;
      // Pi's own model-switch status replaces info notifications before they render.
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", [ctx.ui.theme.italic(hint)]);
      else ctx.ui.notify(hint, "info");
    }
  }
  for (const event of ["session_start", "session_tree", "model_select"]) pi.on(event, refreshStatus);
  pi.on("input", (event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", undefined);
    const id = ctx.model?.id;
    if (ctx.model?.provider !== "autorouter" || !Object.hasOwn(config.models, id)) return { action: "continue" };
    let prefix;
    try {
      prefix = parseTierPrefix(event.text);
    } catch (error) {
      // Print/JSON notifications are no-ops; let routing fail explicitly instead of silently handling it.
      if (!ctx.hasUI) return { action: "continue" };
      ctx.ui.notify(error.message, "error");
      return { action: "handled" };
    }
    // Prompt prefixes stay attached until delivery, so removed/aborted queued prompts cannot change mode.
    if (!prefix || prefix.text.trim() || event.images?.length) return { action: "continue" };
    setRoutingMode(pi, ctx, id, prefix.mode);
    refreshStatus(event, ctx);
    ctx.ui.notify(`Auto router: mode set to ${prefix.mode}.`, "info");
    return { action: "handled" };
  });
}
