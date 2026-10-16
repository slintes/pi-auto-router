import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CATEGORIES, createRouter, getRoutingMode, isSubagent, loadConfig, parseTierPrefix, setRoutingMode, setRouterStatus } from "./router.js";

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
  let childRegistration;
  let registrationVersion = 0;
  function disposeChildRegistration() {
    registrationVersion++;
    childRegistration?.dispose();
    childRegistration = undefined;
  }
  async function registerChildExtension(ctx) {
    disposeChildRegistration();
    const version = registrationVersion;
    if (isSubagent(pi) || ctx.model?.provider !== "autorouter" ||
      !Object.hasOwn(config.models, ctx.model.id)) return;
    const source = pi.getCommands().find((command) => command.source === "extension" && command.name === "subagents")?.sourceInfo?.path;
    if (!source) return;
    let apiPath;
    try {
      // Resolve from the loaded owner: separately installed Pi packages are not our Node dependencies.
      apiPath = createRequire(source).resolve("pi-subagents/required-child-extensions");
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      ctx.ui.notify("Auto router: update pi-subagents to enable automatic child routing (required-child-extensions API missing).", "warning");
      return;
    }
    const { registerRequiredChildExtensions } = await import(pathToFileURL(apiPath).href);
    if (version !== registrationVersion) return;
    childRegistration = registerRequiredChildExtensions({
      sessionId: ctx.sessionManager.getSessionId(),
      extensions: [
        { id: "pi-auto-router", path: fileURLToPath(import.meta.url) },
        { id: "pi-auto-router-child", path: fileURLToPath(new URL("./subagent.js", import.meta.url)) },
      ],
    });
  }
  pi.on("session_shutdown", disposeChildRegistration);
  function refreshStatus(event, ctx) {
    const id = ctx.model?.id;
    if (ctx.model?.provider !== "autorouter" || !Object.hasOwn(config.models, id)) {
      ctx.ui.setStatus("pi-auto-router", undefined);
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", undefined);
      return;
    }
    const child = isSubagent(pi);
    const mode = child ? "auto" : getRoutingMode(ctx, id);
    setRouterStatus(ctx, mode);
    if (!child && ctx.hasUI && (event.type === "session_start" ||
      (event.type === "model_select" && event.source !== "restore" && event.previousModel?.provider !== "autorouter"))) {
      const hint = `Auto router: ${CATEGORIES.map((mode) => `:${mode}`).join(" ")} once; add ! for sticky; :auto resets.`;
      // Pi's own model-switch status replaces info notifications before they render.
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", [ctx.ui.theme.italic(hint)]);
      else ctx.ui.notify(hint, "info");
    }
  }
  for (const type of ["session_start", "session_tree", "model_select"]) pi.on(type, async (event, ctx) => {
    refreshStatus(event, ctx);
    if (event.type !== "session_tree") await registerChildExtension(ctx);
  });
  pi.on("input", (event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-auto-router-hint", undefined);
    if (isSubagent(pi)) return { action: "continue" };
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
    if (prefix.mode !== "auto" && !prefix.sticky) {
      ctx.ui.notify(`Auto router: prefix a prompt with :${prefix.mode} for one turn, or use :${prefix.mode}! for sticky mode.`, "info");
      return { action: "handled" };
    }
    setRoutingMode(pi, ctx, id, prefix.mode);
    refreshStatus(event, ctx);
    ctx.ui.notify(prefix.mode === "auto" ? "Auto router: mode set to auto." : `Auto router: sticky mode set to ${prefix.mode}.`, "info");
    return { action: "handled" };
  });
}
