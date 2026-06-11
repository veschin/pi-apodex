# NOTES.md - Pi SDK research findings (Step 0)

Date: 2026-06-11. Pi version: 0.79.1 (`/home/linuxbrew/.linuxbrew/bin/pi`, npm global
install at `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent`).
All findings below verified by reading the installed package's `docs/`, `dist/*.d.ts`,
bundled `examples/`, and by a live smoke test.

## 1. Extension format

- An extension is a TypeScript module exporting a **default factory function**
  `(pi: ExtensionAPI) => void | Promise<void>`. Loaded via jiti - TS runs without a
  compile step. (docs/extensions.md)
- Auto-discovery locations: `~/.pi/agent/extensions/*.ts` or `<dir>/index.ts` (global),
  `.pi/extensions/` (project-local), or explicit `pi -e ./path.ts`. Hot-reload via
  `/reload` for auto-discovered locations.
- Key API surface used by this project:
  - `pi.registerTool({name, label, description, parameters: Type.Object(...), execute(toolCallId, params, signal, onUpdate, ctx)})`
    - LLM-callable tool. `execute` returns `Promise<AgentToolResult<TDetails>>` =
    `{ content: (TextContent|ImageContent)[], details: T }`. `onUpdate` streams progress.
    `signal: AbortSignal | undefined` aborts on Esc.
  - `pi.registerCommand(name, {description, handler(args, ctx)})` - `/command` for the user;
    handler gets `ExtensionCommandContext` (extends `ExtensionContext`).
  - `pi.registerFlag(name, {type, default})` / `pi.getFlag(name)`.
  - `pi.sendMessage({customType, content, display}, {triggerTurn, deliverAs})` - inject a
    message into the session.
  - Parameters schema uses **typebox** (`Type.Object`, `Type.String`, ...); `StringEnum`
    from `@earendil-works/pi-ai` for Google-compatible enums.
- `ExtensionContext` fields that matter here:
  - `ctx.model: Model<any> | undefined` - **the active session model** (verified in
    `dist/core/extensions/types.d.ts:222`).
  - `ctx.modelRegistry: ModelRegistry` - `find(provider, id)`, `getAvailable()`,
    `getApiKeyAndHeaders(model) -> Promise<ResolvedRequestAuth>` where
    `ResolvedRequestAuth = {ok:true, apiKey?, headers?} | {ok:false, error}`.
  - `ctx.ui.notify/confirm/setStatus/setWidget`, `ctx.hasUI`, `ctx.mode`
    (`"tui" | "rpc" | "json" | "print"`), `ctx.cwd`, `ctx.signal`.
- Import resolution inside pi: jiti **aliases** `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`,
  `typebox` to pi's own installed copies (`dist/core/extensions/loader.js:74-92`). So an
  extension may import these without having its own node_modules, and there are no
  class-identity issues with `ctx`-provided objects.

## 2. Nested fresh-context LLM call - the backbone

**The SDK has a clean primitive; no subprocess needed.**

`@earendil-works/pi-ai` exports (dist/stream.d.ts):

```ts
completeSimple<TApi>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>
streamSimple(...): AssistantMessageEventStream   // streaming variant
```

- `Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }` - **built from
  scratch per call -> fully isolated fresh context by construction**. A verifier call sees
  only what we put in `messages`; it can never see the generator's reasoning trace.
- `SimpleStreamOptions extends StreamOptions`: `temperature`, `maxTokens`, `signal`,
  `apiKey`, `headers`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`,
  `reasoning?: ThinkingLevel` ("off"|"minimal"|"low"|"medium"|"high"|"xhigh"),
  `sessionId`, `cacheRetention`.
- Returns `AssistantMessage` with `content` (text/thinking blocks), `usage`
  (input/output/cacheRead/cacheWrite tokens + `cost.total` USD), `stopReason`
  (`"stop"|"length"|"toolUse"|"error"|"aborted"`), `errorMessage?`.
- Worked example in the box: `examples/extensions/summarize.ts` does exactly
  `auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)` then
  `complete(model, {messages}, {apiKey: auth.apiKey, headers: auth.headers})`.
  Same pattern in `qna.ts`, `custom-compaction.ts`, `handoff.ts`.

### Model objects

- `getModel(provider, id)` from `@earendil-works/pi-ai` - built-in models only.
- `ctx.modelRegistry.find(provider, id)` - built-ins + custom `models.json`.
- `ctx.model` - whatever the session is currently running. Provider-agnostic role
  resolution = use `ctx.model` unless a role is explicitly pinned to `provider/id`.

### Standalone (outside a pi session - eval harness)

`AuthStorage.create()` + `ModelRegistry.create(authStorage)` from
`@earendil-works/pi-coding-agent` resolve keys from `~/.pi/agent/auth.json` and env vars
(priority: runtime overrides -> auth.json -> env). So the same core engine runs in-process
under node/tsx with zero pi session. Verified key resolution chain in docs/sdk.md.

## 3. DeepSeek specifics (built-in provider)

From `pi-ai/dist/models.generated.js` (provider `deepseek`, baseUrl
`https://api.deepseek.com`, api **`openai-completions`**):

| model | ctx | maxTokens | reasoning | cost in/out per 1M |
|---|---|---|---|---|
| `deepseek-v4-pro` | 1M | 384K | yes | $0.435 / $0.87 |
| `deepseek-v4-flash` | 1M | 384K | yes | $0.14 / $0.28 |

- `thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" }`
  - only `high`/`xhigh` produce thinking; pass `reasoning: "high"` for deep roles, `"off"`
  for cheap checks.
- `compat.requiresReasoningContentOnAssistantMessages: true` - multi-turn contexts with
  assistant messages need reasoning content preserved. **Design consequence:** all
  sub-calls are single-turn (one user message); any history (previous attempt, critique)
  is embedded into the user message text. This both sidesteps the compat constraint and
  enforces context isolation.
- Smoke test passed: `pi --provider deepseek --model deepseek-v4-flash -p --no-session
  --no-tools --no-extensions --no-skills --no-context-files "Reply with exactly one word: ok"`
  -> `ok`. Keys are wired headlessly; never read them directly - always resolve through
  `ModelRegistry.getApiKeyAndHeaders()`.

## 4. Alternatives considered for nested calls

1. **`completeSimple` in-process** (CHOSEN): lightest, typed, per-call isolation, returns
   usage/cost for budget accounting, supports signal/timeout/retries natively.
2. `pi --mode json -p --no-session ...` subprocess per sub-call - proven pattern (existing
   `research-workflow` extension at ~/work/pi-extensions does this), but ~1-2 s process
   startup per call, JSON event parsing, and no typed usage; rejected for v1 (kept as a
   documented fallback if in-process breaks on a future pi upgrade).
3. `createAgentSession({sessionManager: SessionManager.inMemory(), ...})` - full nested
   agent with tools; heavier startup (resource loading) and unneeded for tool-less
   verifier/grader calls; reserved for a future "verifier with own search tool" iteration.

## 5. Runtimes available on this machine

- node v24.6.0, tsx 4.22.4, bun, deno. Eval harness runs via `npx tsx`.
- For standalone imports the project pins `@earendil-works/pi-coding-agent@0.79.1` in its
  own `package.json` (local node_modules used by tsc/tsx only; inside pi the jiti aliases
  win, so the extension always binds to the running pi's copies).

## 6. Misc facts used in the design

- `pi --list-models` confirms `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash`
  are visible to this install.
- Existing user extensions live at `~/.pi/agent/extensions/` (symlinks to
  ~/work/pi-extensions). This project will be loadable both via `pi -e ~/ai/pi-apodex/index.ts`
  and via a symlink into `~/.pi/agent/extensions/`.
- Brave Search key exists in the environment (per task brief) but web verification is out
  of scope for v1; the verifier audits against task-internal evidence only.
- Tool `execute` may throw - pi surfaces it as a tool error; preferred shape is returning
  structured `{content, details}` and reserving throws for genuine faults.
