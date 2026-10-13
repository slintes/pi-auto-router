import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "./index.js";
import { CATEGORIES, classificationInput, createRouter, loadConfig, parseCategory, validateConfig, validateModelsConfig } from "./router.js";

const modelsExample = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8"));
const example = modelsExample.models.auto;
function config() {
  const value = structuredClone(example);
  value.classifier = { provider: "classify", model: "chat", thinkingLevel: "low" };
  for (const category of CATEGORIES) value.routes[category].provider = category;
  return validateConfig(value);
}
function user(content = "Build a feature") {
  return { role: "user", content, timestamp: 1 };
}
function response(category = "simple") {
  return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ category }) }] };
}
function harness(configuration = config(), result = response()) {
  const models = new Map();
  for (const target of [configuration.classifier, ...Object.values(configuration.routes)]) {
    models.set(`${target.provider}/${target.model}`, { provider: target.provider, id: target.model, api: "chat-api" });
  }
  const calls = [];
  const warnings = [];
  const statuses = [];
  const ctx = {
    modelRegistry: {
      find: (provider, id) => models.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
      streamSimple(model, context, options) {
        calls.push({ model, context, options });
        return { result: () => typeof result === "function" ? result(options) : Promise.resolve(result) };
      },
    },
    ui: { notify: (...args) => warnings.push(args), setStatus: (...args) => statuses.push(args) },
  };
  return { ctx, models, calls, warnings, statuses, route: createRouter(configuration) };
}
function request(overrides = {}) {
  return { reason: "user", thinkingLevel: "off", messages: [user()], ...overrides };
}

test("config requires all five provider/model/thinking triples and rejects typos", () => {
  assert.deepEqual(validateConfig(example), example);
  for (const category of CATEGORIES) {
    const value = structuredClone(example);
    delete value.routes[category];
    assert.throws(() => validateConfig(value), new RegExp(`routes.${category}`));
  }
  for (const mutate of [
    (value) => { delete value.classifier; },
    (value) => { value.classifier.provider = " "; },
    (value) => { value.classifier.model = " model"; },
    (value) => { value.classifier.thinkingLevel = "ultra"; },
    (value) => { value.routes.simple.thinkingLevel = null; },
    (value) => { value.classifier.apiKey = "do not store credentials"; },
    (value) => { value.routes.extra = value.routes.simple; },
    (value) => { value.typo = true; },
    (value) => { value.fallbackCategory = "typo"; },
    (value) => { value.classifierTimeoutMs = 0; },
    (value) => { value.classifierTimeoutMs = 300001; },
    (value) => { value.maxPromptChars = 255; },
    (value) => { value.contextChars = -1; },
    (value) => { value.contextChars = 1.5; },
    (value) => { value.contextChars = null; },
  ]) {
    const value = structuredClone(example);
    mutate(value);
    assert.throws(() => validateConfig(value));
  }
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const value = structuredClone(example);
    value.classifier.thinkingLevel = level;
    assert.equal(validateConfig(value).classifier.thinkingLevel, level);
  }
});

test("optional settings have defaults and allow no conversation context", () => {
  const value = structuredClone(example);
  delete value.fallbackCategory;
  delete value.classifierTimeoutMs;
  delete value.maxPromptChars;
  value.contextChars = 0;
  const validated = validateConfig(value);
  assert.equal(validated.fallbackCategory, "medium");
  assert.equal(validated.classifierTimeoutMs, 30000);
  assert.equal(validated.maxPromptChars, 24000);
  assert.equal(validated.contextChars, 0);
});

test("classification response is strict JSON with optional single markdown fence", () => {
  for (const category of CATEGORIES) {
    assert.equal(parseCategory(` {"category":"${category}"} `), category);
    assert.equal(parseCategory(`\`\`\`json\n{"category":"${category}"}\n\`\`\``), category);
  }
  for (const text of ["simple", "null", "[]", '{"category":"SIMPLE"}', '{"category":"simple","extra":true}', 'Here: {"category":"simple"}', '{"category":"simple"}\n{"category":"medium"}']) {
    assert.throws(() => parseCategory(text));
  }
});

test("classifier sees bounded visible text, never tools, system or thinking; only counts images", () => {
  const settings = { ...config(), maxPromptChars: 256, contextChars: 15 };
  const messages = [
    { role: "system", content: "SYSTEM SECRET" },
    user("old request"),
    { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "a recent answer" }] },
    { role: "toolResult", content: [{ type: "text", text: "TOOL SECRET" }] },
    user([{ type: "text", text: "HEAD" + "x".repeat(1000) + "TAIL" }, { type: "image", data: "SECRET IMAGE" }]),
    { role: "assistant", content: [{ type: "text", text: "after user" }] },
  ];
  const input = classificationInput(messages, settings);
  assert.equal(input.currentPrompt.length, 256);
  assert.ok(input.currentPrompt.startsWith("HEAD"));
  assert.ok(input.currentPrompt.endsWith("TAIL"));
  assert.equal(input.imageCount, 1);
  assert.equal(input.recentConversation.reduce((n, item) => n + item.text.length, 0), 15);
  const serialized = JSON.stringify(input);
  for (const secret of ["SYSTEM SECRET", "PRIVATE", "TOOL SECRET", "SECRET IMAGE", "after user"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(classificationInput(messages, { ...settings, contextChars: 0 }).recentConversation, []);
  assert.throws(() => classificationInput([], settings), /No user prompt/);
  assert.equal(classificationInput([user([{ type: "image", data: "img" }])], settings).imageCount, 1);
});

for (const category of CATEGORIES) {
  test(`normal chat completion dispatches ${category} with its configured provider/model/level`, async () => {
    const settings = config();
    const h = harness(settings, response(category));
    const route = await h.route(request(), h.ctx);
    assert.equal(route.model.provider, category);
    assert.equal(route.model.id, settings.routes[category].model);
    assert.equal(route.thinkingLevel, settings.routes[category].thinkingLevel);
    assert.deepEqual(route.state, { category, target: settings.routes[category] });
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.model.provider, "classify");
    assert.equal(call.options.reasoning, "low");
    assert.equal(call.options.maxTokens, 2048);
    assert.ok(!("tools" in call.context));
    assert.equal(JSON.parse(call.context.messages[0].content).currentPrompt, "Build a feature");
    assert.equal(h.warnings.length, 0);
    assert.match(h.statuses[0][1], new RegExp(`^${category} ->`));
  });
}

test("off thinking is represented by omitting provider-neutral reasoning", async () => {
  const settings = config();
  settings.classifier.thinkingLevel = "off";
  const h = harness(settings);
  await h.route(request(), h.ctx);
  assert.ok(!Object.hasOwn(h.calls[0].options, "reasoning"));
});

test("each new user prompt reclassifies; continuations and restored state do not", async () => {
  let chosen = "simple";
  const settings = config();
  const h = harness(settings, () => Promise.resolve(response(chosen)));
  const first = await h.route(request(), h.ctx);
  const state = JSON.parse(JSON.stringify(first.state));
  chosen = "reasoning";
  const next = await h.route(request({ state }), h.ctx);
  assert.equal(next.model.provider, "reasoning");
  assert.equal(h.calls.length, 2);
  const storedTarget = structuredClone(next.state.target);
  settings.routes.reasoning.model = "edited-config";
  const continued = await h.route(request({ reason: "continuation", state: next.state, previous: { model: first.model, thinkingLevel: "low" } }), h.ctx);
  assert.equal(continued.model.id, storedTarget.model);
  assert.equal(continued.thinkingLevel, storedTarget.thinkingLevel);
  assert.equal(h.calls.length, 2);
  assert.equal(continued.state, undefined);
  const restored = await createRouter(config())(request({ reason: "continuation", state: next.state }), h.ctx);
  assert.deepEqual(restored, continued);
});

test("retry uses failed physical pair; routing-error retries use persisted choice", async () => {
  const h = harness();
  const failed = { model: { provider: "failed-provider", id: "failed-model", api: "chat-api" }, thinkingLevel: "minimal" };
  const retried = await h.route(request({ reason: "retry", failed }), h.ctx);
  assert.deepEqual(retried, failed);
  const initial = await h.route(request(), h.ctx);
  const recovered = await h.route(request({ reason: "retry", state: initial.state }), h.ctx);
  assert.equal(recovered.model, initial.model);
  assert.equal(h.calls.length, 1);
});

test("direct requests and stateless continuations use previous or fallback without classification", async () => {
  const h = harness();
  const previous = { model: { provider: "previous", id: "model", api: "chat-api" }, thinkingLevel: "high" };
  for (const reason of ["direct", "continuation", "retry"]) {
    assert.deepEqual(await h.route(request({ reason, previous }), h.ctx), previous);
    const fallback = await h.route(request({ reason }), h.ctx);
    assert.equal(fallback.model.provider, "medium");
    assert.equal(fallback.state, undefined);
  }
  assert.equal(h.calls.length, 0);
});

test("classifier exceptions, bad JSON, token exhaustion and errors warn and use configured fallback", async () => {
  const settings = config();
  settings.fallbackCategory = "complex";
  const failures = [
    () => Promise.reject(new Error("SECRET provider body")),
    { stopReason: "error", content: [], errorMessage: "SECRET" },
    { ...response(), stopReason: "length" },
    { ...response(), content: [{ type: "text", text: "garbage SECRET" }] },
    { ...response(), content: [] },
  ];
  for (const failure of failures) {
    const h = harness(settings, failure);
    const routed = await h.route(request(), h.ctx);
    assert.equal(routed.model.provider, "complex");
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0][1], "warning");
    assert.ok(!h.warnings[0][0].includes("SECRET"));
  }
});

test("missing or unauthenticated classifier falls back, virtual classifier is rejected", async () => {
  for (const failure of ["missing", "auth", "virtual"]) {
    const settings = config();
    const h = harness(settings);
    if (failure === "missing") h.models.delete("classify/chat");
    if (failure === "auth") h.ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider !== "classify";
    if (failure === "virtual") h.models.get("classify/chat").api = "pi-virtual";
    const routed = await h.route(request(), h.ctx);
    assert.equal(routed.model.provider, "medium");
    assert.equal(h.calls.length, 0);
    assert.equal(h.warnings.length, 1);
  }
});

test("missing, unauthenticated or virtual task models fail rather than substitute", async () => {
  for (const failure of ["missing", "auth", "virtual"]) {
    const settings = config();
    const h = harness(settings);
    const key = `simple/${settings.routes.simple.model}`;
    if (failure === "missing") h.models.delete(key);
    if (failure === "auth") h.ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider !== "simple";
    if (failure === "virtual") h.models.get(key).api = "pi-virtual";
    await assert.rejects(h.route(request(), h.ctx), /pi-auto-router:/);
    assert.equal(h.warnings.length, 0);
  }
});

test("classifier deadline aborts request even when provider does not settle", async () => {
  const settings = { ...config(), classifierTimeoutMs: 10 };
  const h = harness(settings, () => new Promise(() => {}));
  const result = await h.route(request(), h.ctx);
  assert.equal(result.model.provider, "medium");
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.warnings.length, 1);
});

test("user cancellation before or during classification never falls back", async () => {
  const before = harness();
  const cancelled = AbortSignal.abort(new Error("cancelled before"));
  await assert.rejects(before.route(request({ signal: cancelled }), before.ctx), /cancelled before/);
  assert.equal(before.calls.length, 0);
  const h = harness(config(), () => new Promise(() => {}));
  const controller = new AbortController();
  const routed = h.route(request({ signal: controller.signal }), h.ctx);
  controller.abort(new Error("cancelled during"));
  await assert.rejects(routed, /cancelled during/);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.statuses.length, 0);
});

test("config files report the path on invalid JSON or missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));
  try {
    const path = join(dir, "invalid.json");
    writeFileSync(path, "{");
    assert.throws(() => loadConfig(path), /cannot load .*invalid.json/);
    assert.throws(() => loadConfig(join(dir, "missing.json")), /cannot load .*missing.json/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("multiple-model config validates every router and supports old single-router files", () => {
  assert.deepEqual(validateModelsConfig(modelsExample), modelsExample);
  assert.deepEqual(validateModelsConfig(example), { models: { auto: example } });
  for (const value of [null, [], { models: {} }, { models: [] }, { models: null },
    { models: { "bad/id": example } }, { models: { " bad": example } },
    { models: { "": example } }, { models: { auto: {} } },
    { models: { auto: example }, classifier: example.classifier }]) {
    assert.throws(() => validateModelsConfig(value));
  }
  assert.throws(() => validateModelsConfig({ models: { fast: {} } }), /models.fast/);
});

test("extension registers independent routers at startup; CLI overrides env; invalid config fails loading", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));
  const originalEnv = process.env.PI_AUTO_ROUTER_CONFIG;
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.PI_AUTO_ROUTER_CONFIG;
    else process.env.PI_AUTO_ROUTER_CONFIG = originalEnv;
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "config.json");
  const auto = config();
  const fast = config();
  fast.classifier.model = "fast-classifier";
  fast.routes.simple.model = "fast-task";
  fast.routes.simple.thinkingLevel = "off";
  writeFileSync(path, JSON.stringify({ models: { auto, fast } }));
  process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "missing-env.json");
  process.argv = ["node", "pi", "--auto-router-config", path];
  const definitions = new Map();
  let flag;
  const pi = {
    registerFlag: (name, options) => { flag = { name, ...options }; },
    getFlag: () => undefined,
    registerVirtualModel: (value) => { definitions.set(value.id, value); },
  };
  extension(pi);
  assert.equal(flag.name, "auto-router-config");
  assert.deepEqual([...definitions.keys()], ["auto", "fast"]);
  for (const definition of definitions.values()) {
    assert.equal(definition.provider, "autorouter");
    assert.deepEqual(definition.thinkingLevels, ["off"]);
    assert.equal(typeof definition.route, "function");
  }
  const a = harness(auto);
  const f = harness(fast);
  const autoRoute = await definitions.get("auto").route(request(), a.ctx);
  const fastRoute = await definitions.get("fast").route(request(), f.ctx);
  assert.equal(autoRoute.model.id, auto.routes.simple.model);
  assert.equal(fastRoute.model.id, "fast-task");
  assert.equal(fastRoute.thinkingLevel, "off");
  assert.equal(a.calls[0].model.id, "chat");
  assert.equal(f.calls[0].model.id, "fast-classifier");
  assert.notDeepEqual(autoRoute.state.target, fastRoute.state.target);
  for (const [id, h, state] of [["auto", a, autoRoute.state], ["fast", f, fastRoute.state]]) {
    const continued = await definitions.get(id).route(request({ reason: "continuation", state }), h.ctx);
    assert.equal(continued.model.id, state.target.model);
    assert.equal(h.calls.length, 1);
  }
  // No mid-session reconfiguration; a new factory reads the updated file.
  writeFileSync(path, JSON.stringify({ models: { fast } }));
  assert.equal((await definitions.get("auto").route(request(), a.ctx)).model.id, auto.routes.simple.model);
  definitions.clear();
  process.argv = ["node", "pi", `--auto-router-config=${path}`];
  extension(pi);
  assert.deepEqual([...definitions.keys()], ["fast"]);
  process.argv = ["node", "pi"];
  process.env.PI_AUTO_ROUTER_CONFIG = path;
  extension(pi);
  pi.getFlag = () => join(dir, "missing-cli.json");
  assert.throws(() => extension(pi), /cannot load .*missing-cli.json/);
  pi.getFlag = () => undefined;
  writeFileSync(path, JSON.stringify(auto));
  definitions.clear();
  extension(pi);
  assert.deepEqual([...definitions.keys()], ["auto"]);
  writeFileSync(path, JSON.stringify({ models: { auto, broken: {} } }));
  definitions.clear();
  assert.throws(() => extension(pi), /cannot load .*models.broken/);
  assert.equal(definitions.size, 0);
  writeFileSync(path, "{}");
  assert.throws(() => extension(pi), /cannot load/);
});
