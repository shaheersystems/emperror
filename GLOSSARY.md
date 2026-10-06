# Glossary

Domain language for this codebase. Name modules, types, and tests after these terms.

**Coding agent**: the stateful conversation with the model (`CodingAgent`). Owns message history and runs one turn per user message.

**Turn**: one user message and everything the model does in response: streamed text plus any number of tool calls, capped at `MAX_STEPS`.

**Workspace**: the repository the agent works in, rooted at a directory. Every file operation goes through it, and no path may leave the root (`src/workspace/`).

**Outcome**: the result of a workspace operation. Either `ok: true` with a `summary`, or `ok: false` with a stable failure `code` and a `message`. Operations return outcomes and never throw, so the model can recover and the CLI can render any result the same way.

**Tool**: a model-facing adapter over one workspace operation: its name, input schema, status line (`describeCall`), and the outcome it returns (`src/tools/`).
