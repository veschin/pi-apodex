---
id: extension
kind: spec
touches: index.ts, package.json
---

# Pi extension surface

See also: [30_subcall_infra.md](30_subcall_infra.md) · [10_scope.md](10_scope.md).

## Registered surface (index.ts)

- **Tool `apodex`** (LLM-callable): params `task`, `mode?`
  (auto|design|code|incident|general), `rounds?` (1-10), `candidates?` (1-8).
  Streams progress via `onUpdate` (last 8 lines); errors return
  `isError: true` with progress-so-far. The host's abort signal IS threaded
  (Esc cancels sub-calls).
- **Delivery contract (`composeDelivery`)**: the pipeline produces a verified
  ANSWER, never workspace changes. Result = spend summary (cost, sub-calls,
  tokens in/out, wall) + answer **inline only when <= `INLINE_ANSWER_LIMIT`
  (1500 chars)**; longer answers are delivered as `<runDir>/final.md` path +
  400-char preview + a NEXT STEP directive (read the file, then
  apply/implement or present; never paste the file back). Tool details carry
  `finalAnswerPath`.
- **`/apodex <task>`**: posts a chat-visible launch echo immediately (a slash
  command consumes the input line - without the echo the run looks dead for
  minutes; real incident), mirrors progress to a widget above the editor
  (last 4 stages) + footer status, posts result or an explicit FAILED message
  to chat. The result message uses **`triggerTurn: true`** - the session
  model wakes up and finishes the user's request from the delivery (chat
  channel always carries the NEXT STEP directive, even inline). Verified
  headless up to the message send; the wake-up itself is TUI behavior
  (print mode exits without waiting for triggered turns). **Known gap: this
  path passes `signal: undefined` - a command-run pipeline is not abortable
  from the TUI** (ctx.signal is undefined outside turns; backlog).
- **`/apodex-config`**: prints effective config + session model.

## Integration facts (do not re-derive; verified in NOTES.md)

1. **jiti aliasing**: inside pi, imports of `@earendil-works/pi-coding-agent`,
   `@earendil-works/pi-ai`, `typebox` resolve to **pi's own copies**
   (loader.js alias table). Therefore the extension runs from a pristine
   clone with **no node_modules** (verified live).
2. Consequence - **SDK packages live in `devDependencies` ON PURPOSE**:
   `pi install` does a production install, so keeping them out of
   `dependencies` keeps installation instant. Do not "fix" this by moving
   them back. `npm install` (dev) is needed only for tsc and the eval
   harness.
3. Auth: always `ctx.modelRegistry.getApiKeyAndHeaders(model)` in-session,
   `ModelRegistry.create(AuthStorage.create())` standalone
   (eval/standalone.ts). Never read key material directly.
4. `ctx.model` = active session model -> default binding for heavy roles.
   `ctx.hasUI` guards every notify/status/widget call (print/RPC modes).
5. Custom `display: true` messages render in the TUI transcript but are NOT
   echoed in `-p` print mode - verify command-path changes via run artifacts,
   not stdout.

## Install / distribution

- One-liner: `pi install git:github.com/veschin/pi-apodex` (pi clones over
  HTTPS). HTTPS-filtered networks (this machine without VPN):
  `git clone git@github.com:veschin/pi-apodex ~/.pi/agent/extensions/pi-apodex`.
  Local dev install = that same symlink (currently in place).
- Hot reload after edits: `/reload` in the session. Do NOT `/reload` while a
  command-launched run is in flight - the stale instance may fail to deliver
  the result message (artifacts still land on disk).
- A pipeline run dies with the invoking process; artifacts written so far
  survive, `final.md`/`run.json` do not (end-of-run writes).
