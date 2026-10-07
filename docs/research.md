# Research Report: Introducing SQLite Persistence (Sessions, Chats, Threads) in Emperror

## Executive Summary
Introducing SQLite to persist **sessions, chats, and threads** in Emperror is **moderately easy** from an architectural standpoint, but requires careful design around state boundaries. Because Bun has native, built-in SQLite support (`import { Database } from "bun:sqlite"`), no external dependencies (like `better-sqlite3` or `prisma`) are needed. 

However, because the project is structured as a monorepo (`packages/core`, `packages/cli`, `packages/tui`) with a clean separation of concerns (Core handles agent logic/tools, CLI/TUI handle interaction), SQLite persistence touches both internal state management in `CodingAgent` and database lifecycle/schema management in `@emperror/core`.

---

## 1. Current State Analysis
- **Conversation State:** `CodingAgent` (`packages/core/src/agent/agent.ts`) currently holds messages strictly in-memory: `private readonly messages: ModelMessage[] = []`.
- **Sessions/Threads/Chats:** Currently **non-existent**. Every run of the CLI or TUI starts a fresh, empty conversation.
- **Persistence:** The only persistence currently in the project is tool approval settings saved to `.emperror/settings.json` via `createProjectPolicy`.
- **Runtime Environment:** Runs on **Bun** (`"devDependencies": { "@types/bun": "latest" }`), which provides built-in high-performance SQLite (`bun:sqlite`).

---

## 2. Architectural Impact & Requirements

To introduce SQLite persistence for sessions, chats, and threads, we need to answer four design questions:
1. **Where does the database live?** 
   - Option A: Global user data dir (e.g., `~/.emperror/emperror.db`).
   - Option B: Project-local database (e.g., `.emperror/emperror.db` or `.emperror/chat.db`), mirroring how `.emperror/settings.json` works.
2. **What are the data entities?**
   - **Threads / Chats:** A container for a conversation (metadata: `id`, `title`, `created_at`, `updated_at`, `model`).
   - **Messages (Session state):** Individual turns/messages associated with a thread (`id`, `thread_id`, `role` [user/assistant/tool], `content` [JSON serialized Vercel AI SDK `ModelMessage` or custom format], `created_at`).
   - **Sessions:** Could either map 1:1 with Threads or represent an active CLI/TUI execution run linked to a thread.
3. **API Changes in `CodingAgent`:**
   - `CodingAgent` needs to accept a `threadId` or load an existing thread's messages upon instantiation.
   - Methods to create threads, list threads, switch threads, and delete threads.
4. **UI Integration (CLI / TUI):**
   - Need commands/menus in CLI/TUI to:
     - Resume the last active thread or start a new one (`emperror --resume`, or `/threads` command in REPL).
     - Switch threads interactively.

---

## 3. Implementation Complexity & Steps

### Difficulty: **Low to Moderate** (Estimated ~1-2 days of focused work)

#### Step 1: Database Layer (`packages/core/src/db/`)
- Create a SQLite database helper using `bun:sqlite`.
- Define tables for `threads` and `messages`.
- Implement migration / schema initialization on startup.

```sql
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON serialized ModelMessage content
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Step 2: Update `CodingAgent` (`packages/core/src/agent/agent.ts`)
- Refactor `messages` array to be loadable/syncable with the database repository.
- When `agent.send(...)` successfully appends messages to the conversation, immediately persist them to SQLite under the active `threadId`.

#### Step 3: Core Exports (`packages/core/src/index.ts`)
- Expose thread management functions (`createThread`, `listThreads`, `loadThreadMessages`, etc.) via `@emperror/core`.

#### Step 4: CLI / TUI Commands (`packages/cli` & `packages/tui`)
- Add CLI arguments (e.g., `--thread <id>`, `--new`) or interactive REPL commands (`/threads`, `/new`).
- Update TUI header/sidebar (if applicable) to display current thread info.

---

## 4. Risks & Gotchas
1. **Serialization of Vercel AI SDK `ModelMessage`:**
   - Vercel AI SDK messages can contain complex tool invocations, tool results, and multi-part content arrays. Storing them as JSON strings in SQLite requires ensuring proper serialization/deserialization without losing type fidelity.
2. **Concurrent Access:**
   - Bun's SQLite handles WAL mode well, but CLI and TUI instances shouldn't write to the same project database simultaneously without care (though typical usage is single-user per terminal).
3. **Scope Creep:**
   - Defining clear boundaries between *Sessions*, *Chats*, and *Threads* is crucial. Often, "Chat" and "Thread" mean the same thing in LLM apps. Keeping terminology unified (e.g., just `threads` containing `messages`) avoids unnecessary table complexity.
