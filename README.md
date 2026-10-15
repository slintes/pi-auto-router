# Pi Auto Router

A Pi extension that registers multiple virtual models under **`autorouter`**.
Each uses a normal chat LLM to classify new user prompts, then dispatches them
to its own configured models and thinking levels. Use a short `:tier` prefix to
select a sticky tier instead of automatic classification.
No Jev, Decisions API, extra service, build step, or runtime dependencies.
Built against Pi 1.1.0's `registerVirtualModel` API.

## Start

For a fresh checkout, copy the example to Pi's user-level config path:

```sh
mkdir -p ~/.pi/agent
cp config.example.json ~/.pi/agent/autorouter.json
```

The example defines `autorouter/auto` (tiered routing) and `autorouter/fast`
(all categories use Luna with low thinking). Edit the provider/model IDs to
match your Pi catalog. Authenticate with `/login` as usual; credentials stay
in Pi, not this configuration.

```sh
pi -e ~/dev/work/pi-auto-router/index.js --model autorouter/auto
```

To load the package permanently (this changes your Pi settings):

```sh
pi install ~/dev/work/pi-auto-router
pi --model autorouter/auto
```

Select another configured router with `/model` or `--model autorouter/fast`.
Use exact physical provider and model IDs from `pi --list-models`. Each category may use
a different provider, the same model with different thinking levels, or both.
All targets and the classifier must be physical **chat** models, not other
virtual routers, classifier-only models, or image-generation models.

## Configuration

A single config contains a non-empty `models` map. Each key is the selectable
virtual model ID; each value is a complete, independent router configuration.
IDs start with a letter or digit and contain letters, digits, dots, underscores,
or hyphens. Add more entries to register more routers. There are no shared
settings or inheritance. See `config.example.json` for a two-router example.

```json
{
  "models": {
    "auto": {
      "classifier": {
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "thinkingLevel": "low"
      },
      "routes": {
        "simple": {
          "provider": "openai-codex",
          "model": "gpt-5.6-luna",
          "thinkingLevel": "low"
        },
        "medium": {
          "provider": "openai-codex",
          "model": "gpt-5.6-terra",
          "thinkingLevel": "medium"
        },
        "complex": {
          "provider": "openai-codex",
          "model": "gpt-5.6-sol",
          "thinkingLevel": "high"
        },
        "reasoning": {
          "provider": "openai-codex",
          "model": "gpt-5.6-sol",
          "thinkingLevel": "xhigh"
        }
      },
      "fallbackCategory": "medium",
      "classifierTimeoutMs": 30000,
      "maxPromptChars": 24000,
      "contextChars": 6000
    }
  }
}
```

Each virtual model requires `classifier` and all four `routes`. Each target requires `provider`,
`model`, and `thinkingLevel`. Valid levels: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`. Pi clamps levels unsupported by a target model.
The virtual model offers only `off`: its selection level does not override
configured physical-model levels. Set them in the JSON, not `--thinking`.

Optional settings within each model:

| Setting | Default | Meaning |
| --- | --- | --- |
| `fallbackCategory` | `medium` | Route used if classification fails; also used for requests with no prior choice |
| `classifierTimeoutMs` | `30000` | Deadline in milliseconds, 1-300000 |
| `maxPromptChars` | `24000` | Current prompt character budget, 256-1000000; oversized prompts retain beginning and end |
| `contextChars` | `6000` | Recent user/assistant text character budget, 0-100000; set 0 to send only the current prompt |

Unknown settings, invalid levels, missing routes, malformed JSON, and out-of-range
values are rejected rather than silently ignored. The entire config is validated
and loaded during extension startup, before model selection; an invalid entry
prevents all routers from registering. Restart Pi or use `/reload` after editing.
Each virtual model keeps separate branch-local routing state.

Existing single-router config files (top-level `classifier` and `routes`) still
register `autorouter/auto`. To add routers, wrap the old configuration in
`{"models":{"auto": ...}}` and add other entries alongside `auto`.
The provider ID changed from `auto-router` to `autorouter`: update CLI arguments
and saved default-model settings. Old sessions must select the new virtual model
again; their old router state is not migrated.

### Alternate config files

Precedence: CLI flag, environment variable, then `autorouter.json` in Pi's agent
directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set).
There is no automatic project-local config discovery.

```sh
pi -e ~/dev/work/pi-auto-router/index.js \
  --auto-router-config ~/my-router.json --model autorouter/auto

PI_AUTO_ROUTER_CONFIG=~/my-router.json \
  pi -e ~/dev/work/pi-auto-router/index.js --model autorouter/auto
```

Relative paths resolve against the launch directory; `~/` is supported.
A missing or invalid configuration fails extension startup before any classifier
or task API call.
The CLI flag supports both `--auto-router-config path` and
`--auto-router-config=path`. During startup, it is read from process arguments
because Pi applies extension flag values after factories have run.

## Manual tier controls

Every fresh session starts in **auto** mode. Prefix a prompt with a tier to select
it for that prompt and all subsequent user messages until you choose another mode:

```text
:complex Refactor the authentication flow.
Now update the tests.                      (still complex)
:reasoning Compare these two approaches.   (switches to reasoning)
:auto Fix this typo.                       (automatic routing resumes immediately)
```

Controls: `:simple`, `:medium`, `:complex`, `:reasoning`, and `:auto`.
They are lowercase, exact tokens at the start of a prompt (leading whitespace is
allowed), followed by whitespace or the end of the message. A bare control such
as `:complex` or `:auto` changes mode without calling any model. Unknown leading
`:name` controls report an error and leave the mode unchanged; occurrences inside
a prompt, prose headings such as `complex:`, and fenced code are not controls.
In print mode (`-p`), Pi may repeat the previous assistant answer after a bare
control; this is a display behavior, not a new model call.

- Manual mode bypasses the classifier entirely. It selects the configured tier
  in the **currently selected router**, not a different virtual model. Each router
  keeps its own mode on the active session branch.
- A prefix attached to a prompt takes effect when Pi processes that prompt, not
  when it is queued. Removing or cancelling an undelivered queued prompt does not
  change mode. If Pi delivers multiple user messages together, the last control
  in that batch wins.
- Bare controls take effect immediately, including while Pi is working. They
  affect subsequent user requests, not the physical model already handling the
  current turn's tool chain or retry. Queued prompts use the mode active when
  processed, unless they carry their own prefix.
- `/new` starts in auto. Resume, reload, compaction, forks, and session-tree
  navigation preserve the mode recorded on that branch. Older sessions without
  a saved mode start in auto. Switching to a physical model hides the router
  status and leaves that router's saved mode intact.
- The status shows forced tiers in **bold, uppercase orange**, without a
  "locked" label. Auto mode is muted and chosen categories stay lowercase.
  Only the mode name is emphasized. Non-TUI modes use plain text.
- Prefixes remain in the task prompt and conversation history. The classifier's
  current prompt omits `:auto`; recent conversation can still contain prefixes.
  Mode entries store plain data, never terminal styling.

A forced tier with an unavailable model or missing credentials fails explicitly;
it never silently falls back or re-enables auto. The selected mode remains saved,
so you can fix credentials or select `:auto`/another tier. This feature does not
change `/plan` mode or tool permissions.

## Routing contract

1. In auto mode, every new user message, including steering/follow-up messages,
   gets a new classification. Manual mode reuses the selected tier until changed.
   Automatically chosen categories never become sticky modes.
2. The classifier receives a system instruction and a JSON payload containing
   the bounded current prompt, bounded recent conversation text, and an image
   count. It has **no tools** and does not receive the main system prompt,
   tool results, private thinking, or actual images.
3. It returns `{"category":"simple"}`, `medium`, `complex`, or `reasoning`.
   Strict JSON is required; a single JSON Markdown fence is also accepted.
4. The chosen physical provider/model/thinking triple is persisted in Pi's
   branch-local router state. Tool continuations reuse it, even after resume,
   compaction, or reload. Automatic retries reuse the failed physical pair.
   Routing failures without a failed pair reuse stored state, except unresolved
   manual user turns retry the forced tier rather than substitute an old target.
5. Direct requests such as compaction use the previous physical model when
   available, otherwise the fallback category. They are not classified and
   do not change branch routing state.

Categories:

| Category | Intended work |
| --- | --- |
| `simple` | Greetings, short factual questions, tiny localized edits |
| `medium` | Routine features, debugging, tests, reviews, bounded implementation |
| `complex` | Broad architecture/planning, migrations, cross-cutting changes, difficult debugging |
| `reasoning` | Primarily deep analysis, proof, math, logic, or hypothesis/trade-off evaluation |

Large implementation planning is `complex`; `reasoning` is for tasks whose
main deliverable is analysis. This is an LLM judgment, not a guarantee.
The footer shows the physical dispatch; a status line also shows the routing mode
and, after an automatic dispatch, the chosen category.
Routing does **not** turn on `/plan` mode or change any tool permissions.

## Failures, privacy, and cost

- Classifier errors, missing classifier credentials/model, timeouts, truncated
  responses, and invalid output produce a warning and use `fallbackCategory`.
  Warning text deliberately excludes raw provider errors and prompt contents.
- User cancellation propagates; it never causes a fallback completion.
- Missing route models/credentials and virtual-model targets fail the request
  explicitly. There is no silent target substitution or cross-provider retry.
- In auto mode, text is sent to the **classifier provider as well as the chosen
  task provider**. Recent assistant answers can contain sensitive data. Set `contextChars` to 0
  or choose a trusted/local classifier if needed. Prompt instructions cannot
  make an LLM classifier immune to prompt injection.
- In auto mode, classification adds a paid chat request and latency for each new
  user prompt. Classifier output has a 2048-token cap; unusually heavy classifier thinking
  can exhaust it and trigger fallback. A fast model with low thinking is best.
- Classifier calls are out-of-band; do not assume Pi's session cost includes
  them. Provider billing does. Switching task models can lose prompt-cache reuse.
- Images are counted, not analyzed. Routing image-heavy requests relies on
  accompanying text; the task model receives images subject to Pi capabilities.

## Development

```sh
npm test
node --check index.js
node --check router.js
bash test/pi-smoke.sh
```

Tests use Node's built-in runner and fake Pi model registries; no installs,
credentials, or billed requests are required. They cover validation, parsing,
context bounds, each route, failures, cancellation, timeout, sticky turns,
retry/direct behavior, persisted state, independent routers, legacy config,
startup config selection, sticky tier controls, standalone switches, queued
prefixes, branch restoration, target failures, and status styling.
The smoke script additionally starts real Pi CLI processes against a mock
in-process chat provider, verifying both virtual models, all four routes,
thinking levels, package loading, CLI config precedence, and sticky controls
across saved-session resumes. It uses isolated temporary Pi settings
and makes no network or paid model requests.
