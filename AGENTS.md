# AGENTS.md — pi-devin-local

Pi package that registers the `devin` provider. Auth and the model catalog come from the local Devin CLI. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin`
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/desktop-auth.ts   # reuse a Devin Desktop sign-in when the CLI store is missing
src/models.ts         # GetCliModelConfigs RPC → DevinCatalog → ProviderModelConfig[] (`devin models list` as fallback)
src/thinking.ts       # thinking summary + sealed signature round-trip
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/hedge.ts          # DEVIN_HEDGE=N race: N identical requests, first to emit wins
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history (+ system prompt for slot 2)
```

## Contract

- `/login devin` must call `devin auth login` when no local credential exists. Reusing the session token a signed-in Devin Desktop already stores on disk is allowed; a custom paste/device flow is not.
- Model IDs must come from the live catalog — `ApiServerService/GetCliModelConfigs` over Connect/protobuf (same RPC as `devin models list`; requires ide `windsurf` in Metadata — `devin-desktop` gets a 1-entry gated list), with `devin models list` as fallback. Never a hardcoded cloud allowlist.
- One pi model per Devin family: the id is the family slug and pi's thinking level picks the variant (`swe-2` + `max` → `swe-2-max`). Never bake a level into the model id.
- Levels a family does not ship must be `null` in `thinkingLevelMap`, so pi hides them instead of silently falling back.
- The request must mirror the Devin CLI: system prompt in `GetChatMessageRequest.prompt` (2) — never collapsed into the first user turn; `configuration` (8) = num_completions 1, max_tokens, max_newlines 400, temperature 1.0, top_k 40, top_p 0.95; `trajectory_reference` (15) = own uuid + CASCADE/USER_INPUT; `planner_mode` (20) = DEFAULT; `chat_model_uid` (21). Do not set `execution_id` (22) — the CLI leaves it empty.
- Client identity in `Metadata` stays `devin-desktop`; Cognition gates Devin Local-only models (GPT-5.6 family) by ide name, and only that value is verified for it.
- Thinking must round-trip: keep the server's `delta_signature` / `delta_signature_type` on the thinking block and replay `thinking` / `signature` / `thinking_redacted` / `signature_type` (11/12/13/18) on the next request, like the Devin CLI does. The server verifies the trace; dropping it loses the model's own reasoning.
- The server only sends a thinking *summary* (`delta_thinking`). The full trace stays inside the sealed signature and is not readable client-side.
- Field numbers come from the `exa.api_server_pb` descriptors embedded in Devin's language server binary (`/Applications/Devin.app/.../bin/language_server_macos_arm`) — check them there instead of guessing.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`. The npm name is `pi-devin-local` (upstream owns `pi-devin`), so the gallery lists this fork separately.
