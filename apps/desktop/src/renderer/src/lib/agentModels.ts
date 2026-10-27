/** Claude Code's `--model` aliases: each names the latest model of its family. */
export const MODELS = [
  { value: "fable", label: "Fable", hint: "Most capable, for hard features" },
  { value: "opus", label: "Opus", hint: "Strong all-round coding" },
  { value: "sonnet", label: "Sonnet", hint: "Fast, a good balance for most steps" },
  { value: "haiku", label: "Haiku", hint: "Fastest and lightest" },
];

/** "" is the default: what it means depends on where it is chosen (the run, a workflow step). */
export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** Claude Code's `--effort` levels: how long the model thinks before acting. */
export const EFFORTS: Array<{ value: Exclude<Effort, "">; label: string; hint: string }> = [
  { value: "low", label: "Low", hint: "Quickest answers, least thinking" },
  { value: "medium", label: "Medium", hint: "Some thinking" },
  { value: "high", label: "High", hint: "Thinks things through" },
  { value: "xhigh", label: "Extra high", hint: "Deep thinking, slower" },
  { value: "max", label: "Max", hint: "As much thinking as it takes; slowest, uses the most quota" },
];
