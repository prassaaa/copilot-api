export const MODEL_LEVELS = ["low", "medium", "high", "xhigh"] as const

export type ModelLevel = (typeof MODEL_LEVELS)[number]

const CLAUDE_MODEL_LEVEL_VARIANTS = {
  "claude-opus-4.6": ["low", "medium", "high"],
  "claude-opus-4.6-fast": ["low", "medium", "high"],
  "claude-sonnet-4.6": ["low", "medium", "high"],
} as const satisfies Record<string, ReadonlyArray<ModelLevel>>

const CLAUDE_45_AUTO_REASONING_MODELS = new Set([
  "claude-opus-4.5",
  "claude-sonnet-4.5",
])

export const parseModelNameWithLevel = (
  model: string,
): {
  baseModel: string
  level: ModelLevel | undefined
} => {
  const match = model.match(/^(.+)\((low|medium|high|xhigh)\)$/)
  if (!match) {
    return {
      baseModel: model,
      level: undefined,
    }
  }

  return {
    baseModel: match[1],
    level: match[2] as ModelLevel,
  }
}

export const isGptResponsesModel = (model: string): boolean =>
  model.startsWith("gpt-")

export const supportsGptReasoningEffort = (model: string): boolean =>
  model.startsWith("gpt-5")

export const getModelLevelsForModel = (
  model: string,
): ReadonlyArray<ModelLevel> | undefined => {
  if (supportsGptReasoningEffort(model)) {
    return MODEL_LEVELS
  }

  return CLAUDE_MODEL_LEVEL_VARIANTS[
    model as keyof typeof CLAUDE_MODEL_LEVEL_VARIANTS
  ]
}

export const isClaudeThinkingModel = (model: string): boolean =>
  model === "claude-opus-4.6"
  || model === "claude-opus-4.6-fast"
  || model === "claude-sonnet-4.6"

export const isClaude45AutoReasoningModel = (model: string): boolean =>
  CLAUDE_45_AUTO_REASONING_MODELS.has(model)
