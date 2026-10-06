import { describeToolCall, type ApprovalDecision, type ApprovalRequest } from "@emperror/core";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { colors } from "./theme.ts";

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onDecide(decision: ApprovalDecision): void;
}

/**
 * Asks whether a tool call may run. Choose with ↑↓ and Enter, or press the
 * option's number; Esc denies.
 */
export function ApprovalPrompt({ request, onDecide }: ApprovalPromptProps) {
  const options: { decision: ApprovalDecision; label: string }[] = [
    { decision: "allow-once", label: "Yes" },
    {
      decision: "allow-always",
      label: `Yes, and don't ask again for ${request.toolName} in this project`,
    },
    { decision: "deny", label: "No" },
  ];
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(options.length - 1, i + 1));
    else if (key.return) onDecide(options[selected]!.decision);
    else if (key.escape) onDecide("deny");
    else {
      const picked = options[Number(input) - 1];
      if (picked) onDecide(picked.decision);
    }
  });

  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={colors.warn}
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color={colors.warn}>
        Allow this action?
      </Text>
      <Text>
        {describeToolCall(request.toolName, request.input)}
        <Text dimColor> ({request.toolName})</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((option, i) => (
          <Text key={option.decision} color={i === selected ? colors.accent : undefined}>
            {i === selected ? "❯ " : "  "}
            {i + 1}. {option.label}
          </Text>
        ))}
      </Box>
      <Text dimColor>↑↓ select · enter confirm · esc deny</Text>
    </Box>
  );
}
