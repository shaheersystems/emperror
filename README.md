# emperror-has-no-clothes

A lightweight, modular AI coding agent built with **TypeScript** and **Bun**. It
lets an LLM interact with the local filesystem through native, structured tool
calling powered by the [Vercel AI SDK](https://ai-sdk.dev) and Google Gemini.

## Features

- **AI SDK core**: All model and tool-calling operations run through the Vercel
  AI SDK (`streamText`, `tool`, `stepCountIs`), so tool calls are structured and
  validated rather than parsed from free text.
- **Streaming responses**: Assistant text and tool activity stream to the
  terminal as they happen.
- **Agentic loop**: Autonomous multi-step execution with a safety cap
  (`MAX_STEPS`) to prevent runaway tool loops.
- **Filesystem tools**: Built-in reading, listing, and editing of files.
- **Sandboxed by design**: Every tool path is confined to the repo root via a
  shared sandbox.
- **Human approval**: Every tool call asks first (Yes / Yes, and don't ask
  again for this tool in this project / No). Project-wide approvals are saved
  to `.emperror/settings.json`:
  ```json
  { "permissions": { "allow": ["read_file", "list_files"] } }
  ```
- **Bash tool**: runs commands with bash (Git Bash on Windows) in the repo
  root. It is guarded rather than sandboxed: every command needs approval and
  can never be allowed project-wide (not even via `settings.json`). The exact
  command is shown, with control and bidi characters escaped. Credential-like
  environment variables are removed and stdin is closed. Commands time out and
  the process tree is killed, and output is capped.
- **Typed config**: Environment variables are validated with Zod at startup, so
  misconfiguration fails fast with a clear message.

## Project Structure

A Bun workspace. The agent core has no UI code; each user interface is its own
package that depends on core's public entry point (`@emperror/core`).

```text
packages/
├── core/              # @emperror/core: the agent, no UI dependencies
│   └── src/
│       ├── index.ts     # Public interface: createConfiguredAgent, events, tool text
│       ├── config/      # Zod-validated environment configuration
│       ├── ai/          # CodingAgent (streamText + history), provider, system prompt
│       ├── tools/       # AI SDK tool adapters over the workspace and shell
│       ├── shell/       # Guarded bash runner (timeouts, scrubbed env, capped output)
│       └── workspace/   # Workspace: sandboxed file operations returning Outcomes
├── tui/               # @emperror/tui: Ink terminal UI (default)
│   └── src/             # app.tsx, prompt-input.tsx, transcript.ts, main.tsx
└── cli/               # @emperror/cli: minimal chalk/ora REPL, also works with piped input
```

UIs only drive a `CodingAgent` and render the `AgentEvent`s it emits; they never
talk to the model or the filesystem directly. See `GLOSSARY.md` for the domain terms.

## Prerequisites

- [Bun](https://bun.sh) installed (v1.2.5 or later).
- A Google Generative AI (Google AI Studio) API key.

## Getting Started

1.  **Install**:
    ```bash
    bun install
    ```

2.  **Configure**: copy `.env.example` to `.env` and fill it in:
    ```bash
    GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
    GOOGLE_MODEL=gemini-2.5-flash   # optional, this is the default
    BASE_URL=                       # optional, for a proxy/gateway
    ```

3.  **Run** the terminal UI (or `bun run start:cli` for the plain REPL):
    ```bash
    bun run start
    ```

4.  **Test**:
    ```bash
    bun test
    ```

## Adding New Tools

1.  If it touches files, add the operation to the `Workspace` in
    `packages/core/src/workspace/workspace.ts`, returning an `Outcome`.
2.  Add an entry to `definitions` in `packages/core/src/tools/index.ts`: a
    description, a Zod `inputSchema`, a `describeCall` status line, and `run`.

The model receives the new tool's name, description, and schema on the next run,
and both UIs render its status and result without further changes.
