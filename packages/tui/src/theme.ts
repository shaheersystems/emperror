/** Colors for Ink's `color` props, centralized so the look is retuned in one place. */
export const colors = {
  brand: "#c084fc", // soft violet
  accent: "#22d3ee", // cyan
  user: "#34d399", // green
  border: "gray",
  ok: "green",
  warn: "yellow",
  err: "red",
} as const;

/** Shown beside the spinner while the agent is thinking between actions. */
const WORKING_VERBS = [
  "Noodling",
  "Percolating",
  "Marinating",
  "Tinkering",
  "Conjuring",
  "Wrangling",
  "Pondering",
  "Brewing",
  "Scheming",
  "Whirring",
];

export function workingVerb(): string {
  return WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)]!;
}
