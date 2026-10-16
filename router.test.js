import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import extension from "./index.js";
import subagentExtension from "./subagent.js";
import { CATEGORIES, MODE_ENTRY, classificationInput, createRouter, getRoutingMode, loadConfig, parseCategory, parseTierPrefix, setRoutingMode, setRouterStatus, validateConfig, validateModelsConfig } from "./router.js";

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
function harness(configuration = config(), result = response(), id = "auto", branch = []) {
  const models = new Map();
  for (const target of [configuration.classifier, ...Object.values(configuration.routes)]) {
    models.set(`${target.provider}/${target.model}`, { provider: target.provider, id: target.model, api: "chat-api" });
  }
  const calls = [];
  const warnings = [];
  const statuses = [];
  const widgets = new Map();
  const pi = { appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }) };
  const ctx = {
    mode: "rpc", hasUI: true,
    model: { provider: "autorouter", id, api: "pi-virtual" },
    sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
    modelRegistry: {
      find: (provider, id) => models.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
      streamSimple(model, context, options) {
        calls.push({ model, context, options });
        return { result: () => typeof result === "function" ? result(options) : Promise.resolve(result) };
      },
    },
    ui: {
      notify: (...args) => warnings.push(args), setStatus: (...args) => statuses.push(args),
      setWidget: (key, content) => content === undefined ? widgets.delete(key) : widgets.set(key, content),
    },
  };
  return { ctx, pi, branch, models, calls, warnings, statuses, widgets, route: createRouter(configuration, pi, id) };
}
function enableChildRouter(pi) {
  const listeners = new Map();
  pi.events = { on: (channel, listener) => listeners.set(channel, listener),
    emit: (channel, data) => listeners.get(channel)?.(data) };
  subagentExtension(pi);
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
    assert.match(h.statuses.at(-1)[1], new RegExp(`^auto -> ${category} ->`));
  });
}

test("tier prefixes distinguish one-turn and sticky choices and require exact leading tokens", () => {
  for (const mode of ["auto", ...CATEGORIES]) {
    assert.deepEqual(parseTierPrefix(`  :${mode}\nDo the work`), { mode, sticky: false, text: "Do the work" });
    assert.deepEqual(parseTierPrefix(`:${mode}   `), { mode, sticky: false, text: "" });
  }
  for (const mode of CATEGORIES) {
    assert.deepEqual(parseTierPrefix(`:${mode}! Do the work`), { mode, sticky: true, text: "Do the work" });
  }
  for (const text of ["complex: heading", "Explain :complex", "```\n:complex\n```", ":", "hello"]) {
    assert.equal(parseTierPrefix(text), undefined);
  }
  for (const text of [":reasoining task", ":Complex task", ":auto! task", ":complex!! task", ":autoSECRET task"]) {
    assert.throws(() => parseTierPrefix(text), /Use :auto, :simple, :simple!, :medium, :medium!, :complex, :complex!, :reasoning, :reasoning!/);
  }
});

for (const category of CATEGORIES) {
  test(`:${category}! sticks across new prompts, survives restoration, and bypasses even a broken classifier`, async () => {
    const h = harness(config(), () => { throw new Error("Classifier must not run"); });
    h.models.delete("classify/chat");
    const first = await h.route(request({ messages: [user(`:${category}! Do work`)] }), h.ctx);
    assert.equal(first.model.provider, category);
    assert.equal(getRoutingMode(h.ctx, "auto"), category);
    const next = await createRouter(config(), h.pi)(request({ state: first.state }), h.ctx);
    assert.equal(next.model.provider, category);
    assert.equal(h.calls.length, 0);
    assert.equal(h.warnings.length, 0);
    assert.match(h.statuses.at(-1)[1], new RegExp(`^${category.toUpperCase()} ->`));
    assert.equal(h.branch.length, 1);
    assert.equal(JSON.stringify(h.branch).includes("\\u001b"), false);
  });
}

test("one-turn tiers override the saved mode only for their prompt", async () => {
  const h = harness(config(), response("simple"));
  const first = await h.route(request({ messages: [user(":complex Do work")] }), h.ctx);
  assert.equal(first.model.provider, "complex");
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.deepEqual(h.branch, []);
  const next = await h.route(request({ state: first.state, messages: [user("Also update tests")] }), h.ctx);
  assert.equal(next.model.provider, "simple");
  assert.equal(h.calls.length, 1);

  setRoutingMode(h.pi, h.ctx, "auto", "reasoning");
  const override = await h.route(request({ messages: [user(":simple Just this one")] }), h.ctx);
  assert.equal(override.model.provider, "simple");
  assert.equal(getRoutingMode(h.ctx, "auto"), "reasoning");
  const resumed = await h.route(request({ state: override.state, messages: [user("Continue")] }), h.ctx);
  assert.equal(resumed.model.provider, "reasoning");
  assert.equal(h.calls.length, 1);
});

test(":auto clears a lock, strips only the classifier's current marker, and stays automatic", async () => {
  const h = harness(config(), response("simple"));
  const locked = await h.route(request({ messages: [user(":complex! Do work")] }), h.ctx);
  const resetMessages = [user(":auto Classify this")];
  const reset = await h.route(request({ state: locked.state, messages: resetMessages }), h.ctx);
  assert.equal(reset.model.provider, "simple");
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.equal(JSON.parse(h.calls[0].context.messages[0].content).currentPrompt, "Classify this");
  assert.equal(resetMessages[0].content, ":auto Classify this");
  await h.route(request({ state: reset.state }), h.ctx);
  assert.equal(h.calls.length, 2);
});

test("only directives in the new user batch change mode; the last directive wins", async () => {
  const h = harness();
  const messages = [user(":reasoning! old"), response(), user(":complex! next"), user("Also tests")];
  const routed = await h.route(request({ messages }), h.ctx);
  assert.equal(routed.model.provider, "complex");
  const next = await h.route(request({ state: routed.state, messages: [
    ...messages, response(), user(":simple! smaller"), user(":reasoning! analyze"), user("And compare"),
  ] }), h.ctx);
  assert.equal(next.model.provider, "reasoning");
  setRoutingMode(h.pi, h.ctx, "auto", "auto");
  await h.route(request({ messages: [...messages, response(), user("No directive")] }), h.ctx);
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.equal(h.calls.length, 1);
});

test("mode follows the branch and router ID, not the last classified category or abandoned entries", () => {
  const h = harness();
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  setRoutingMode(h.pi, h.ctx, "auto", "complex");
  const fork = structuredClone(h.branch);
  setRoutingMode(h.pi, h.ctx, "fast", "simple");
  setRoutingMode(h.pi, h.ctx, "auto", "auto");
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.equal(getRoutingMode(h.ctx, "fast"), "simple");
  const restored = harness(config(), response(), "auto", fork);
  assert.equal(getRoutingMode(restored.ctx, "auto"), "complex");
  assert.equal(getRoutingMode(restored.ctx, "fast"), "auto");
  h.branch.length = 0;
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  h.branch.push({ type: "custom", customType: MODE_ENTRY, data: { id: "auto", mode: "invalid" } });
  assert.throws(() => getRoutingMode(h.ctx, "auto"), /invalid saved mode/);
});

test("bad prefixes do not classify, leak their text, or change the current mode", async () => {
  const h = harness();
  setRoutingMode(h.pi, h.ctx, "auto", "complex");
  await assert.rejects(h.route(request({ messages: [user(":simple valid"), user(":SECRET invalid")] }), h.ctx), (error) => {
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
  assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
  assert.equal(h.calls.length, 0);
  assert.equal(h.warnings.length, 0);
});

test("forced target failures keep the selected mode and never classify or substitute", async () => {
  for (const failure of ["missing", "auth", "virtual"]) {
    const settings = config();
    const h = harness(settings);
    const key = `complex/${settings.routes.complex.model}`;
    if (failure === "missing") h.models.delete(key);
    if (failure === "auth") h.ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider !== "complex";
    if (failure === "virtual") h.models.get(key).api = "pi-virtual";
    await assert.rejects(h.route(request({ messages: [user(":complex! work")] }), h.ctx), /pi-auto-router:/);
    assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
    assert.equal(h.calls.length, 0);
    assert.equal(h.warnings.length, 0);
  }
});

test("retry after :auto reuses its classified target instead of reclassifying", async () => {
  let category = "complex";
  const h = harness(config(), () => Promise.resolve(response(category)));
  setRoutingMode(h.pi, h.ctx, "auto", "reasoning");
  const messages = [user(":auto Do work")];
  const first = await h.route(request({ messages }), h.ctx);
  assert.equal(first.model.provider, "complex");
  category = "simple";
  const retry = await h.route(request({ reason: "retry", state: first.state, messages }), h.ctx);
  assert.equal(retry.model, first.model);
  assert.equal(h.calls.length, 1);
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
});

test("routing-error retries cannot substitute the previous turn's target for a forced tier", async () => {
  const settings = config();
  const h = harness(settings);
  const previous = await h.route(request(), h.ctx);
  const key = `complex/${settings.routes.complex.model}`;
  const model = h.models.get(key);
  h.models.delete(key);
  const messages = [user(":complex work")];
  await assert.rejects(h.route(request({ messages, state: previous.state }), h.ctx), /not in Pi's chat catalog/);
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  await assert.rejects(h.route(request({ reason: "retry", messages, state: previous.state }), h.ctx), /not in Pi's chat catalog/);
  h.models.set(key, model);
  const recovered = await h.route(request({ reason: "retry", messages, state: previous.state }), h.ctx);
  assert.equal(recovered.model.provider, "complex");
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.equal(h.calls.length, 1);
});

test("standalone mode switches cannot reroute an in-flight turn, retries or direct requests", async () => {
  const h = harness();
  const first = await h.route(request({ messages: [user(":complex work")] }), h.ctx);
  setRoutingMode(h.pi, h.ctx, "auto", "simple");
  for (const reason of ["continuation", "retry"]) {
    const next = await h.route(request({ reason, state: first.state, messages: [user(":reasoning ignored"), response()] }), h.ctx);
    assert.equal(next.model.provider, "complex");
    assert.equal(getRoutingMode(h.ctx, "auto"), "simple");
  }
  const previous = { model: first.model, thinkingLevel: first.thinkingLevel };
  assert.deepEqual(await h.route(request({ reason: "direct", previous }), h.ctx), previous);
  assert.deepEqual(await h.route(request({ reason: "retry", failed: previous }), h.ctx), previous);
  assert.equal((await h.route(request(), h.ctx)).model.provider, "simple");
  assert.equal(h.calls.length, 0);
});

test("forced status is uppercase, bold and orange only in TUI; auto stays muted", () => {
  const h = harness();
  const styles = [];
  h.ctx.mode = "tui";
  h.ctx.ui.theme = {
    appearance: "dark",
    style: (text, options) => { styles.push({ text, options }); return `<style>${text}</style>`; },
    fg: (token, text) => `<${token}>${text}</${token}>`,
  };
  setRouterStatus(h.ctx, "complex", "complex", config().routes.complex);
  assert.match(h.statuses.at(-1)[1], /^<style>COMPLEX<\/style> ->/);
  assert.deepEqual(styles[0], { text: "COMPLEX", options: { fg: { kind: "rgb", r: 255, g: 165, b: 0 }, bold: true } });
  setRouterStatus(h.ctx, "auto", "complex", config().routes.complex);
  assert.match(h.statuses.at(-1)[1], /^<muted>auto<\/muted> -> complex ->/);
  h.ctx.ui.theme.appearance = "light";
  setRouterStatus(h.ctx, "reasoning");
  assert.deepEqual(styles.at(-1).options.fg, { kind: "rgb", r: 166, g: 82, b: 0 });
  h.ctx.mode = "rpc";
  setRouterStatus(h.ctx, "simple");
  assert.equal(h.statuses.at(-1)[1], "SIMPLE");
});

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

test("child routers start in auto despite inherited modes and routing state", async () => {
  const parent = harness();
  setRoutingMode(parent.pi, parent.ctx, "auto", "complex");
  const parentRoute = await parent.route(request(), parent.ctx);
  const parentState = parentRoute.state;
  for (const inherited of [undefined, parentState, { ...parentState, sessionId: "parent-session" }]) {
    const branch = structuredClone(parent.branch);
    const h = harness(config(), response("simple"), "auto", branch);
    enableChildRouter(h.pi);
    const route = createRouter(config(), h.pi);
    const result = await route(request({ state: inherited,
      previous: { model: parentRoute.model, thinkingLevel: parentRoute.thinkingLevel },
      messages: [user(":complex parent task"), response(), user("Find a definition")] }), h.ctx);
    assert.equal(result.model.provider, "simple");
    assert.equal(result.state.sessionId, "test-session");
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.parse(h.calls[0].context.messages[0].content).currentPrompt, "Find a definition");
    assert.deepEqual(branch, parent.branch);
    assert.match(h.statuses.at(-1)[1], /^auto -> simple ->/);
  }
  assert.equal(getRoutingMode(parent.ctx, "auto"), "complex");
  assert.equal(parent.calls.length, 0);
});

test("child routers classify only the first task and retain the choice across follow-ups and reloads", async () => {
  const settings = config();
  const h = harness(settings, response("reasoning"));
  enableChildRouter(h.pi);
  const route = createRouter(settings, h.pi);
  const first = await route(request(), h.ctx);
  const state = JSON.parse(JSON.stringify(first.state));
  settings.routes.reasoning.model = "edited-config";
  for (const reason of ["user", "continuation", "retry", "direct"]) {
    const next = await route(request({ reason, state, messages: [user(":simple Follow up")] }), h.ctx);
    assert.equal(next.model, first.model);
    assert.equal(next.thinkingLevel, first.thinkingLevel);
    assert.equal(next.state, undefined);
  }
  const restored = await createRouter(config(), h.pi)(request({ state }), h.ctx);
  assert.equal(restored.model, first.model);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.branch, []);
  const failed = { model: first.model, thinkingLevel: "minimal" };
  assert.deepEqual(await route(request({ reason: "retry", state, failed }), h.ctx), failed);
  assert.equal(h.calls.length, 1);
});

test("forking an already-routed child makes a new automatic choice without altering its parent", async () => {
  let category = "simple";
  const h = harness(config(), () => Promise.resolve(response(category)));
  enableChildRouter(h.pi);
  const route = createRouter(config(), h.pi);
  const parent = await route(request(), h.ctx);
  category = "complex";
  h.ctx.sessionManager.getSessionId = () => "fork-session";
  const fork = await route(request({ state: parent.state, previous: parent }), h.ctx);
  assert.equal(fork.model.provider, "complex");
  assert.equal(fork.state.sessionId, "fork-session");
  h.ctx.sessionManager.getSessionId = () => "test-session";
  assert.equal((await route(request({ state: parent.state }), h.ctx)).model.provider, "simple");
  assert.equal(h.calls.length, 2);
});

test("child routers keep a fallback choice and fail explicitly if their pinned target disappears", async () => {
  const h = harness(config(), () => Promise.reject(new Error("classifier unavailable")));
  enableChildRouter(h.pi);
  const route = createRouter(config(), h.pi);
  const first = await route(request(), h.ctx);
  assert.equal(first.model.provider, "medium");
  assert.equal((await route(request({ state: first.state }), h.ctx)).model, first.model);
  h.models.delete(`${first.model.provider}/${first.model.id}`);
  await assert.rejects(route(request({ state: first.state }), h.ctx), /not in Pi's chat catalog/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.warnings.length, 1);
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

test("automatic child registration uses the loaded owner, follows lifecycle, and preserves other owners", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-router-child-registration-"));
  const originalEnv = process.env.PI_AUTO_ROUTER_CONFIG;
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.PI_AUTO_ROUTER_CONFIG;
    else process.env.PI_AUTO_ROUTER_CONFIG = originalEnv;
    rmSync(dir, { recursive: true });
  });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config()));
  process.env.PI_AUTO_ROUTER_CONFIG = configPath;
  process.argv = ["node", "pi"];
  const owner = join(dir, "local-package");
  mkdirSync(owner);
  writeFileSync(join(owner, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module",
    exports: { "./required-child-extensions": "./api.js" } }));
  writeFileSync(join(owner, "index.js"), "");
  writeFileSync(join(owner, "api.js"), `
    export const registrations = [];
    export function registerRequiredChildExtensions(input) {
      if (registrations.some((entry) => !entry.disposed && entry.input.sessionId === input.sessionId))
        throw new Error("duplicate registration");
      const entry = { input, disposed: false, dispose() { this.disposed = true; } };
      registrations.push(entry);
      return entry;
    }
  `);
  const api = await import(pathToFileURL(join(owner, "api.js")).href);
  const h = harness();
  const handlers = new Map();
  const command = { name: "subagents", source: "extension", sourceInfo: { path: join(owner, "index.js") } };
  let commands = [command];
  let child = false;
  Object.assign(h.pi, {
    registerFlag() {}, registerVirtualModel() {},
    getFlag: () => undefined,
    events: { emit: (_channel, state) => { state.subagent = child; } },
    getCommands: () => commands,
    on: (event, handler) => handlers.set(event, handler),
  });
  extension(h.pi);
  const emit = (type) => handlers.get(type)({ type }, h.ctx);
  await emit("session_start");
  assert.deepEqual(api.registrations[0].input, { sessionId: "test-session",
    extensions: [
      { id: "pi-auto-router", path: fileURLToPath(new URL("./index.js", import.meta.url)) },
      { id: "pi-auto-router-child", path: fileURLToPath(new URL("./subagent.js", import.meta.url)) },
    ] });
  await emit("session_tree");
  assert.equal(api.registrations.length, 1);
  await emit("model_select");
  assert.equal(api.registrations.length, 2);
  assert.equal(api.registrations[0].disposed, true);
  h.ctx.model = { provider: "physical", id: "model" };
  await emit("model_select");
  assert.ok(api.registrations.every((entry) => entry.disposed));
  h.ctx.model = { provider: "autorouter", id: "auto" };
  const pending = emit("model_select");
  h.ctx.model = { provider: "physical", id: "model" };
  await emit("model_select");
  await pending;
  assert.equal(api.registrations.length, 2);
  h.ctx.model = { provider: "autorouter", id: "auto" };
  await emit("session_start");
  await emit("session_shutdown");
  assert.ok(api.registrations.every((entry) => entry.disposed));
  h.ctx.sessionManager.getSessionId = () => "new-session";
  await emit("session_start");
  assert.equal(api.registrations.at(-1).input.sessionId, "new-session");
  child = true;
  await emit("session_start");
  assert.ok(api.registrations.every((entry) => entry.disposed));
  child = false;
  commands = [];
  const count = api.registrations.length;
  await emit("session_start");
  assert.equal(api.registrations.length, count);
  commands = [{ ...command, source: "prompt" }];
  await emit("session_start");
  assert.equal(api.registrations.length, count);
  const oldOwner = join(dir, "old-package");
  mkdirSync(oldOwner);
  writeFileSync(join(oldOwner, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module", exports: {} }));
  writeFileSync(join(oldOwner, "index.js"), "");
  commands = [{ name: "subagents", source: "extension", sourceInfo: { path: join(oldOwner, "index.js") } }];
  await emit("session_start");
  assert.match(h.warnings.at(-1)[0], /update pi-subagents.*required-child-extensions API missing/);
  assert.equal(h.warnings.at(-1)[1], "warning");
  commands = [command];
  const external = api.registerRequiredChildExtensions({ sessionId: "new-session", extensions: [] });
  await assert.rejects(emit("session_start"), /duplicate registration/);
  assert.equal(external.disposed, false);
  external.dispose();
});

test("input controls handle bare switches, defer queued prefixes, preserve images and restore lifecycle status", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-router-input-"));
  const originalEnv = process.env.PI_AUTO_ROUTER_CONFIG;
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.PI_AUTO_ROUTER_CONFIG;
    else process.env.PI_AUTO_ROUTER_CONFIG = originalEnv;
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ models: { auto: config(), fast: config() } }));
  process.env.PI_AUTO_ROUTER_CONFIG = path;
  process.argv = ["node", "pi"];
  const h = harness();
  const handlers = new Map();
  const definitions = new Map();
  Object.assign(h.pi, {
    registerFlag() {}, getFlag() {}, getCommands: () => [],
    on: (event, handler) => handlers.set(event, handler),
    registerVirtualModel: (definition) => definitions.set(definition.id, definition),
  });
  extension(h.pi);
  const input = (text, extra = {}) => handlers.get("input")({ text, ...extra }, h.ctx);
  const refresh = (event, extra = {}) => handlers.get(event)({ type: event, ...extra }, h.ctx);
  const hint = ["Auto router: :simple :medium :complex :reasoning once; add ! for sticky; :auto resets.", "info"];
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    h.warnings.length = 0;
    refresh("session_start", { reason });
    assert.deepEqual(h.warnings, [hint]);
    assert.equal(h.statuses.at(-1)[1], "auto");
  }
  for (const source of ["set", "cycle"]) {
    h.warnings.length = 0;
    refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source });
    assert.deepEqual(h.warnings, [hint]);
  }
  h.warnings.length = 0;
  refresh("session_tree");
  refresh("model_select", { previousModel: { provider: "autorouter", id: "fast" }, source: "set" });
  refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source: "restore" });
  assert.deepEqual(h.warnings, []);
  for (const model of [undefined, { provider: "physical", id: "model" }, { provider: "autorouter", id: "unknown" }]) {
    h.ctx.model = model;
    refresh("session_start");
    refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source: "set" });
    assert.deepEqual(h.warnings, []);
  }
  h.ctx.model = { provider: "autorouter", id: "auto" };
  for (const mode of ["print", "json"]) {
    h.ctx.mode = mode;
    h.ctx.hasUI = false;
    refresh("session_start");
    refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source: "set" });
    assert.deepEqual(h.warnings, []);
  }
  h.ctx.mode = "tui";
  h.ctx.hasUI = true;
  h.ctx.ui.theme = {
    fg: (_color, text) => text, style: (text) => text,
    italic: (text) => `<italic>${text}</italic>`,
  };
  const italicHint = `<italic>${hint[0]}</italic>`;
  refresh("session_start");
  assert.deepEqual(h.widgets.get("pi-auto-router-hint"), [italicHint]);
  assert.deepEqual(h.warnings, []);
  let uiStatus = "";
  h.ctx.ui.notify = (text) => { uiStatus = text; };
  refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source: "set" });
  h.ctx.ui.notify("Model: auto", "info");
  assert.equal(uiStatus, "Model: auto");
  assert.deepEqual(h.widgets.get("pi-auto-router-hint"), [italicHint]);
  assert.deepEqual(input("Next prompt"), { action: "continue" });
  assert.equal(h.widgets.has("pi-auto-router-hint"), false);
  refresh("model_select", { previousModel: { provider: "physical", id: "model" }, source: "set" });
  assert.equal(h.widgets.has("pi-auto-router-hint"), true);
  h.ctx.model = { provider: "physical", id: "model" };
  refresh("model_select", { previousModel: { provider: "autorouter", id: "auto" }, source: "set" });
  assert.equal(h.widgets.has("pi-auto-router-hint"), false);
  h.ctx.model = { provider: "autorouter", id: "auto" };
  h.ctx.ui.notify = (...args) => h.warnings.push(args);
  h.ctx.mode = "rpc";
  assert.deepEqual(h.branch, []);
  assert.equal(h.calls.length, 0);
  refresh("session_start");
  h.warnings.length = 0;
  assert.deepEqual(input(":complex"), { action: "handled" });
  assert.deepEqual(h.warnings, [["Auto router: prefix a prompt with :complex for one turn, or use :complex! for sticky mode.", "info"]]);
  assert.equal(h.statuses.at(-1)[1], "auto");
  assert.equal(getRoutingMode(h.ctx, "auto"), "auto");
  assert.deepEqual(h.branch, []);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(input(":complex!"), { action: "handled" });
  assert.deepEqual(h.warnings.at(-1), ["Auto router: sticky mode set to complex.", "info"]);
  assert.equal(h.statuses.at(-1)[1], "COMPLEX");
  assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
  const snapshot = structuredClone(h.branch);
  assert.deepEqual(input(":simple queued task", { streamingBehavior: "followUp" }), { action: "continue" });
  assert.deepEqual(h.branch, snapshot);
  await assert.rejects(definitions.get("auto").route(request({
    messages: [user(":simple cancelled")], signal: AbortSignal.abort(new Error("cancelled")),
  }), h.ctx), /cancelled/);
  assert.deepEqual(h.branch, snapshot);
  const delivered = await definitions.get("auto").route(request({ messages: [user(":simple queued task")] }), h.ctx);
  assert.equal(delivered.model.provider, "simple");
  assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
  assert.deepEqual(input(":auto", { images: [{ type: "image", data: "img" }] }), { action: "continue" });
  assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
  assert.deepEqual(input(":SECRET task"), { action: "handled" });
  assert.equal(h.warnings.at(-1)[1], "error");
  assert.ok(!h.warnings.at(-1)[0].includes("SECRET"));
  assert.equal(getRoutingMode(h.ctx, "auto"), "complex");
  h.ctx.hasUI = false;
  assert.deepEqual(input(":SECRET task"), { action: "continue" });
  await assert.rejects(definitions.get("auto").route(request({ messages: [user(":SECRET task")] }), h.ctx), /unknown tier/);
  h.ctx.hasUI = true;
  h.ctx.model.id = "fast";
  refresh("model_select");
  assert.equal(h.statuses.at(-1)[1], "auto");
  input(":reasoning!");
  assert.equal(getRoutingMode(h.ctx, "fast"), "reasoning");
  h.ctx.model = { provider: "physical", id: "model" };
  assert.deepEqual(input(":SECRET"), { action: "continue" });
  refresh("model_select");
  assert.equal(h.statuses.at(-1)[1], undefined);
  h.ctx.model = { provider: "autorouter", id: "auto" };
  h.branch.splice(0, h.branch.length, ...snapshot);
  refresh("session_tree");
  assert.equal(h.statuses.at(-1)[1], "COMPLEX");
  h.branch.length = 0;
  refresh("session_start");
  assert.equal(h.statuses.at(-1)[1], "auto");
  h.branch.push(...snapshot);
  extension(h.pi);
  refresh("session_start");
  assert.equal(h.statuses.at(-1)[1], "COMPLEX");
  input(":auto");
  assert.equal(h.statuses.at(-1)[1], "auto");
  assert.equal(h.calls.length, 0);
});

test("extension registers independent routers at startup; CLI overrides env; invalid config fails loading", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));
  const originalEnv = process.env.PI_AUTO_ROUTER_CONFIG;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.PI_AUTO_ROUTER_CONFIG;
    else process.env.PI_AUTO_ROUTER_CONFIG = originalEnv;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "config.json");
  const auto = config();
  const fast = config();
  fast.classifier.model = "fast-classifier";
  fast.routes.simple.model = "fast-task";
  fast.routes.simple.thinkingLevel = "off";
  writeFileSync(path, JSON.stringify({ models: { auto, fast } }));
  writeFileSync(join(dir, "autorouter.json"), JSON.stringify({ models: { auto } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_AUTO_ROUTER_CONFIG;
  process.argv = ["node", "pi"];
  const definitions = new Map();
  let flag;
  const pi = {
    on: () => {},
    registerFlag: (name, options) => { flag = { name, ...options }; },
    getFlag: () => undefined,
    getCommands: () => [],
    registerVirtualModel: (value) => { definitions.set(value.id, value); },
  };
  extension(pi);
  assert.deepEqual([...definitions.keys()], ["auto"]);
  definitions.clear();

  process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "missing-env.json");
  process.argv = ["node", "pi", "--auto-router-config", path];
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
  enableChildRouter(pi);
  for (const [id, settings] of [["auto", auto], ["fast", fast]]) {
    const h = harness(settings);
    const route = definitions.get(id).route;
    const first = await route(request(), h.ctx);
    const next = await route(request({ state: first.state }), h.ctx);
    assert.equal(next.model, first.model);
    assert.equal(next.thinkingLevel, settings.routes.simple.thinkingLevel);
    assert.equal(first.state.sessionId, "test-session");
    assert.equal(h.calls.length, 1);
  }
  delete pi.events;
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
