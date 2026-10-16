import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// shortcut: uses pi-subagents' installed factory and peer loader; update paths if its internal layout changes.
assert.ok(process.argv[2] && process.argv[3],
  "Usage: node test/subagent-smoke.mjs /path/to/pi-subagents /path/to/@earendil-works/pi-coding-agent");
const subagents = resolve(process.argv[2]);
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = resolve(process.argv[3]);
const { resolveHostPeerAliases } = await import(pathToFileURL(join(subagents, "src/runs/background/runner-aliases.js")));
const { aliases, missing } = resolveHostPeerAliases(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT);
assert.deepEqual(missing, [], "Pi host peer dependencies must be available");
process.env.JITI_ALIAS = JSON.stringify(aliases);
process.env.PI_ASYNC_NATIVE_RUNNER = "1";
await import(pathToFileURL(join(subagents, "runner-peer-preload.mjs")));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "pi-auto-router-subagent-"));
let factory;
try {
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  process.env.PI_AUTO_ROUTER_CONFIG = join(tmp, "autorouter.json");
  process.env.PI_OFFLINE = "1";
  process.env.ROUTER_SMOKE_CALL_LOG = join(tmp, "calls.log");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  const config = JSON.parse(readFileSync(join(root, "config.example.json"), "utf8"));
  for (const [id, settings] of Object.entries(config.models)) {
    settings.classifier = { provider: "router-smoke", model: "classifier", thinkingLevel: "off" };
    for (const [category, target] of Object.entries(settings.routes)) {
      target.provider = "router-smoke";
      target.model = category;
      if (id === "fast") target.thinkingLevel = "off";
    }
  }
  writeFileSync(process.env.PI_AUTO_ROUTER_CONFIG, JSON.stringify(config));
  const { createDefaultChildSessionFactory, loadHostPiCodingAgent } = await import(pathToFileURL(
    join(subagents, "src/runs/shared/child-session.js")));
  const sdk = await loadHostPiCodingAgent();
  factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
  const parentProviderRegistry = await sdk.ModelRuntime.create();
  const extensionErrors = [];
  const parent = await factory.create({
    cwd: tmp, storage: { kind: "file", sessionFile: join(tmp, "parent.jsonl") }, model: "autorouter/auto", tools: [],
    parentProviderRegistry, extensionPaths: [join(root, "test/fixtures/mock-provider.js"), join(root, "index.js"), join(subagents, "index.js")],
    ambientExtensions: false, hooks: [], runtime: {}, noSkills: true, noContextFiles: true,
    onExtensionError: (error) => extensionErrors.push(error),
  });
  assert.deepEqual(extensionErrors, []);
  const { resolveSubagentLaunchContract } = await import(pathToFileURL(join(subagents, "src/api/preflight.js")));
  const { resolveRequiredChildExtensions } = await import(pathToFileURL(join(subagents, "src/shared/required-child-extensions.js")));
  const requiredExtensions = resolveRequiredChildExtensions(parent.sessionId);
  assert.deepEqual(requiredExtensions, [
    { id: "pi-auto-router", path: join(root, "index.js") },
    { id: "pi-auto-router-child", path: join(root, "subagent.js") },
  ]);
  const availableModels = [...Object.keys(config.models).map((id) => ({ provider: "autorouter", id })),
    { provider: "router-smoke", id: "reasoning" }];
  for (const parentModel of availableModels) {
    const defaults = await resolveSubagentLaunchContract({ agent: "delegate", task: "simple", cwd: tmp,
      sessionRoot: join(tmp, "preflight"), parentSessionId: parent.sessionId, parentModel, availableModels });
    assert.equal(defaults.ok, true, defaults.message);
    assert.equal(defaults.contract.model.split(":")[0], `${parentModel.provider}/${parentModel.id}`);
    assert.deepEqual(defaults.contract.tools.requiredExtensionIds, ["pi-auto-router", "pi-auto-router-child"]);
  }
  assert.equal(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"), "{}");
  console.log("PASS: child entrypoint is registered automatically with empty settings; model inheritance is unchanged");
  const denied = await resolveSubagentLaunchContract({ agent: "delegate", task: "simple", cwd: tmp,
    sessionRoot: join(tmp, "preflight"), parentSessionId: parent.sessionId, parentModel: availableModels[0], availableModels,
    capabilityCeiling: { sources: ["smoke"], denyExtensions: true } });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /denies extensions/);
  console.log("PASS: automatic loading does not bypass an extension-denying capability ceiling");
  const launch = (sessionFile, model = "autorouter/auto") => ({
    cwd: tmp, storage: { kind: "file", sessionFile }, model, tools: [], parentProviderRegistry,
    extensionPaths: [join(root, "test/fixtures/mock-provider.js"), ...requiredExtensions.map(({ path }) => path)],
    requiredExtensions,
    ambientExtensions: false, hooks: [], runtime: {}, noSkills: true, noContextFiles: true,
    onExtensionError: (error) => extensionErrors.push(error),
  });
  async function check(child, prompt, expected, calls, label) {
    writeFileSync(process.env.ROUTER_SMOKE_CALL_LOG, "");
    await child.prompt(prompt);
    const last = child.messages.findLast((message) => message.role === "assistant");
    assert.equal(last?.stopReason, "stop", last?.errorMessage);
    assert.equal(last.content[0].text, `router-smoke/${expected}`);
    assert.deepEqual(readFileSync(process.env.ROUTER_SMOKE_CALL_LOG, "utf8").trim().split("\n"), calls);
    assert.deepEqual(extensionErrors, []);
    console.log(`PASS: ${label}`);
  }
  function fork(child) {
    const manager = sdk.SessionManager.open(child.sessionFile, join(tmp, "forks"));
    return manager.createBranchedSession(manager.getLeafId());
  }
  const explicit = await factory.create(launch(join(tmp, "explicit.jsonl"), "router-smoke/reasoning:off"));
  await check(explicit, "simple", "reasoning:off", ["reasoning"], "explicit physical-model selection bypasses classification");
  const roleThinking = await factory.create(launch(join(tmp, "role-thinking.jsonl"), "autorouter/auto:high"));
  await check(roleThinking, "simple", "simple:low", ["classifier", "simple"], "role thinking suffix does not override the router's configured thinking");
  const child = await factory.create(launch(join(tmp, "fresh.jsonl")));
  assert.equal(child.virtualModelId, "autorouter/auto");
  await check(child, "simple", "simple:low", ["classifier", "simple"], "fresh native child classifies its first task");
  await check(child, "reasoning", "simple:low", ["simple"], "child follow-up keeps its first model and thinking");
  await child.followUp("complex");
  await check(child, "reasoning", "simple:low", ["simple", "simple"], "queued child follow-up does not reclassify");
  await child.steer("reasoning");
  await check(child, "complex", "simple:low", ["simple"], "queued child steering does not reclassify");

  const otherProfile = await factory.create(launch(join(tmp, "fast.jsonl"), "autorouter/fast"));
  await check(otherProfile, "simple", "simple:off", ["classifier", "simple"], "a different inherited router profile uses its own thinking level");
  await check(otherProfile, "reasoning", "simple:off", ["simple"], "the different router profile also classifies only once");
  for (const [i, paths] of [["index.js", "subagent.js"], ["subagent.js", "index.js"]].entries()) {
    const both = await factory.create({ ...launch(join(tmp, `both-${i}.jsonl`)),
      extensionPaths: [join(root, "test/fixtures/mock-provider.js"), ...paths.map((path) => join(root, path))] });
    await check(both, "simple", "simple:low", ["classifier", "simple"], `child entrypoint works with normal extension (order ${i})`);
    await check(both, "reasoning", "simple:low", ["simple"], `normal extension cannot re-enable per-turn classification (order ${i})`);
  }

  await check(parent, ":complex! Parent task", "complex:high", ["complex"], "ordinary parent still supports sticky forced tiers");
  assert.deepEqual(resolveRequiredChildExtensions(parent.sessionId), requiredExtensions);
  const parentBefore = readFileSync(parent.sessionFile, "utf8");
  const forked = await factory.create(launch(fork(parent)));
  await check(forked, "simple", "simple:low", ["classifier", "simple"], "forked child starts in auto despite parent's forced tier");
  assert.equal(readFileSync(parent.sessionFile, "utf8"), parentBefore);
  await check(parent, "reasoning", "complex:high", ["complex"], "forked child does not change its parent's mode");

  const nested = await factory.create(launch(fork(child)));
  assert.notEqual(nested.sessionId, child.sessionId);
  await check(nested, "reasoning", "reasoning:xhigh", ["classifier", "reasoning"], "fork of a routed child makes its own first choice");
  await check(child, "complex", "simple:low", ["simple"], "nested child does not change the original child's choice");

  const childFile = child.sessionFile;
  const childId = child.sessionId;
  await child.dispose();
  const resumed = await factory.create(launch(childFile));
  assert.equal(resumed.sessionId, childId);
  await check(resumed, "reasoning", "simple:low", ["simple"], "resumed child retains its original choice without classification");

  // Background runners omit the parent registry and host one active child session at a time.
  const backgroundLaunch = { ...launch(join(tmp, "background.jsonl")), parentProviderRegistry: undefined };
  const background = await factory.create(backgroundLaunch);
  await check(background, "complex", "complex:high", ["classifier", "complex"], "background child classifies its first task");
  await check(background, "simple", "complex:high", ["complex"], "background child follow-up keeps its choice");
  await background.dispose();
  const backgroundResumed = await factory.create(backgroundLaunch);
  await check(backgroundResumed, "reasoning", "complex:high", ["complex"], "background child resume does not reclassify");
} finally {
  await factory?.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
