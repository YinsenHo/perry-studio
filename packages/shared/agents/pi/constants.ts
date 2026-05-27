export const CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME = 'Cherry Studio Pi Agent'

export const LEGACY_AGENT_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'

export function normalizeAgentInstructions(instructions?: string | null): string {
  return (instructions ?? '').replace(/\s+/g, ' ').trim()
}

export function buildCherryStudioPiAgentInstructions(name?: string | null): string {
  const normalizedName = normalizeAgentInstructions(name) || CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME
  const quotedName = JSON.stringify(normalizedName)
  const runtimeLine =
    normalizedName.toLowerCase() === 'pi'
      ? 'Use this configured display name as your user-facing identity.'
      : 'Pi is only your internal agent runtime. Do not introduce yourself as Pi unless the user explicitly asks about the underlying engine or runtime.'

  return [
    `You are ${quotedName}, an AI agent running inside Cherry Studio Pi.`,
    `Your configured display name is ${quotedName}. When the user asks your name or identity, answer with this name.`,
    runtimeLine,
    'Help the user complete coding, workspace, and agent tasks.'
  ].join('\n')
}

export function isDefaultCherryStudioPiAgentInstructions(
  instructions: string | undefined,
  name?: string | null
): boolean {
  const normalizedInstructions = normalizeAgentInstructions(instructions)
  if (!normalizedInstructions) return false

  return normalizedInstructions === normalizeAgentInstructions(buildCherryStudioPiAgentInstructions(name))
}

export function isLegacyAgentDefaultInstructions(instructions: string | undefined): boolean {
  return normalizeAgentInstructions(instructions) === normalizeAgentInstructions(LEGACY_AGENT_DEFAULT_INSTRUCTIONS)
}
