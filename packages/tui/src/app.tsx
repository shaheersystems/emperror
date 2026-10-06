import type { AgentEvent } from "@emperror/core";
import { Box, Static, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useReducer, useState } from "react";
import { PromptInput } from "./prompt-input.tsx";
import { colors, workingVerb } from "./theme.ts";
import { emptyTranscript, transcriptReducer, type Entry } from "./transcript.ts";

/** What the TUI needs from the core agent: one turn per call, as events. */
export interface TurnRunner {
  send(input: string, onEvent: (event: AgentEvent) => void): Promise<void>;
}

export interface AppProps {
  agent: TurnRunner;
  modelName: string;
  /** Directory the agent works in, shown in the header. */
  root: string;
}

type StaticItem = Entry | { id: -1; kind: "header" };

export function App({ agent, modelName, root }: AppProps) {
  const { exit } = useApp();
  const [transcript, dispatch] = useReducer(transcriptReducer, emptyTranscript);
  const [history, setHistory] = useState<string[]>([]);

  async function submit(text: string) {
    const command = text.trim().toLowerCase();
    if (command === "exit" || command === "quit") return exit();

    setHistory((h) => [...h, text]);
    dispatch({ type: "submit", text });
    try {
      await agent.send(text, (event) => dispatch({ type: "agent", event }));
    } catch (error) {
      dispatch({ type: "agent", event: { type: "error", error } });
    } finally {
      dispatch({ type: "turn-end" });
    }
  }

  const items: StaticItem[] = [{ id: -1, kind: "header" }, ...transcript.done];

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item.kind === "header" ? (
            <Header key="header" modelName={modelName} root={root} />
          ) : (
            <EntryView key={item.id} entry={item} />
          )
        }
      </Static>

      {transcript.live.map((entry) => (
        <EntryView key={entry.id} entry={entry} />
      ))}

      {transcript.busy && <WorkingLine />}

      <Box marginTop={1} flexDirection="column">
        <PromptInput
          onSubmit={submit}
          onExit={exit}
          history={history}
          canSubmit={!transcript.busy}
        />
        <Text dimColor>
          {"  enter send · \\+enter newline · ↑↓ history · ctrl+c clear/exit"}
        </Text>
      </Box>
    </Box>
  );
}

function Header({ modelName, root }: { modelName: string; root: string }) {
  return (
    <Box borderStyle="round" borderColor={colors.brand} paddingX={1} flexDirection="column">
      <Text color={colors.brand} bold>
        ✦ emperror <Text dimColor>coding agent</Text>
      </Text>
      <Text dimColor>
        model {modelName} · {root}
      </Text>
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <Box
          marginTop={1}
          paddingLeft={1}
          borderStyle="bold"
          borderColor={colors.user}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text>{entry.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text color={colors.accent}>● </Text>
          <Box flexShrink={1}>
            <Text>{entry.text}</Text>
          </Box>
        </Box>
      );
    case "tool":
      return (
        <Box paddingLeft={2}>
          {entry.status === "running" ? (
            <Text color={colors.accent}>
              <Spinner type="dots" />{" "}
            </Text>
          ) : entry.status === "ok" ? (
            <Text color={colors.ok}>✓ </Text>
          ) : (
            <Text color={colors.warn}>✗ </Text>
          )}
          <Text dimColor={entry.status !== "running"}>{entry.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color={colors.err}>✖ {entry.text}</Text>
        </Box>
      );
  }
}

/** Spinner, a whimsical verb and elapsed seconds while a turn runs. */
function WorkingLine() {
  const [verb] = useState(workingVerb);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box marginTop={1}>
      <Text color={colors.brand}>
        <Spinner type="dots" /> {verb}…
      </Text>
      <Text dimColor> {seconds}s</Text>
    </Box>
  );
}
