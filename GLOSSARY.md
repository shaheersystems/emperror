# Glossary

Domain language for this codebase. Name modules, types, and tests after these terms.

**Coding agent**: the stateful conversation with the model (`CodingAgent`). Owns message history and runs one turn per user message.

**Turn**: one user message and everything the model does in response: streamed text plus any number of tool calls, capped at `MAX_STEPS`. Only a completed turn joins the history; a failed one is reported once and leaves the history untouched.

**Workspace**: the repository the agent works in, rooted at a directory. Every file operation goes through it, and no path may leave the root (`packages/core/src/workspace/`).

**Outcome**: the result of a workspace operation. Either `ok: true` with a `summary`, or `ok: false` with a stable failure `code` and a `message`. Operations return outcomes and never throw, so the model can recover and every UI can render any result the same way.

**Tool**: a model-facing adapter over one workspace operation: its name, input schema, status line (`describeCall`), and the outcome it returns (`packages/core/src/tools/`).

**Approval**: the user's answer before a tool call runs: allow once, allow the tool for the whole project, or deny. A denied call never runs; the model gets a failed result with code `denied`.

**Policy**: which tools may run without asking (`ToolPolicy`, `packages/core/src/policy/`). Nothing is allowed by default; "allow for this project" adds the tool to `permissions.allow` in `.emperror/settings.json`.

**Transcript**: the conversation as a UI shows it: rows for user messages, assistant text, tool calls, and errors. Rows are either *done* (final, printed once) or *live* (still streaming or running).
