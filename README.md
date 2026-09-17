# pi-devin-local

Devin Local models in [Pi](https://pi.dev). Auth comes from the local Devin CLI / Devin Desktop session and the model catalog from the live `GetCliModelConfigs` RPC.

> Fork of [`kashyab12/pi-devin`](https://github.com/kashyab12/pi-devin) (npm `pi-devin`). Do not install both: they register the same `devin` provider.

## How it works

Devin credentials are the only stored secret — every model call is plain HTTP, no OpenAI-compat layer.

```text
  ~/.local/share/devin/credentials.toml        (windsurf_api_key — written by `devin auth login`)
        │
        │  /login devin  (only when the file is missing: spawn `devin auth login`,
        │                or reuse a signed-in Devin Desktop token)
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Model request  (per chat message)                           │
  │                                                             │
  │  POST {api_server_url}/exa.api_server_pb.ApiServerService/  │
  │       GetChatMessage                                        │
  │   • Metadata.api_key (field 3)  ← the windsurf_api_key      │
  │   • Metadata.user_jwt (field 21) ← minted via GetUserJwt    │
  │     (api key → GetUserJwt → 15-min JWT; cloud models work   │
  │      with the api key alone, JWT carries plan/entitlement)  │
  │   • system prompt (2), history (3), tools (10), config (8), │
  │     chat_model_uid (21) e.g. "swe-1-7-medium"               │
  │   • Connect RPC + protobuf (application/connect+proto,      │
  │     gzip framing) — NOT an OpenAI-compatible endpoint       │
  └─────────────────────────────────────────────────────────────┘
        ▲
        │  model list: GetCliModelConfigs over HTTP (ide=windsurf),
        │  `devin models list` only as fallback
        └─ never spawns the CLI during normal chat
```

## Why this exists

Older packages treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Those models are only reachable through the local Devin surface. This package reuses that local credential, then streams completions into Pi so Pi's tools, sessions, and UI stay in charge — it is not an ACP integration and does not use Zed.

## Requirements

- [Devin CLI](https://docs.devin.ai/cli) installed (or bundled with Devin Desktop)
- Signed in: `devin auth login`, or a signed-in Devin Desktop on this machine
- Pi Coding Agent — `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are peer deps

## Install

```bash
pi install git:github.com/sting8k/pi-devin
```

Local checkout:

```bash
pi install ~/Developers/pi-devin
```

Restart Pi or run `/reload`.

## Usage

```text
/login devin
/model devin/swe-2
/model devin/claude-opus-5
/model devin/gpt-5.6-sol
```

Models keep their **family id**; thinking levels belong to pi and each level is
resolved to the matching Devin variant. For SWE-2:

| pi thinking level | model uid sent |
|---|---|
| `medium` | `swe-2-medium` |
| `high` (default) | `swe-2-high` |
| `max` | `swe-2-max` |

Use `/thinking` or `shift+tab` to change the level; levels a family does not ship
are hidden, and `Ctrl+S` in `/thinking` saves the startup default. The same
applies to every other family (`devin/kimi-k3`, `devin/grok-4.6`, …).

`/login devin` seeds `~/.local/share/devin/credentials.toml` from a Devin Desktop
sign-in you already have, and otherwise runs `devin auth login`.

Thinking: the server streams a *summary* of the model's reasoning; the full trace
stays inside the sealed signature and never leaves the server. Pi keeps that
summary together with its signature and replays both on the next request, exactly
like the Devin CLI, so the model keeps its own prior reasoning across tool calls
and turns.

### Latency

The provider pre-warms the user JWT and TLS connection at startup and
session start, so the first message skips the ~0.85s of cold-start cost.
Each turn sends exactly one `GetChatMessage` request — hedged duplicate
requests were removed once Devin introduced rate limiting.

Commands:

- `/devin-status` — CLI path, version, auth
- `/devin-refresh` — reload the model catalog

## License

MIT. Unofficial. Not affiliated with Cognition.
