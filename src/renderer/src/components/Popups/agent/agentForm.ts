import type { AgentConfiguration, AgentEntity, BaseAgentForm, Tool } from '@renderer/types'
import { AgentConfigurationSchema, isAgentType, PermissionModeSchema, SchedulerTypeSchema } from '@renderer/types'
import {
  buildCherryStudioPiAgentInstructions,
  CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME,
  isLegacyAgentDefaultInstructions
} from '@shared/agents/pi/constants'

export type AgentWithTools = AgentEntity & { tools?: Tool[] }

export const DEFAULT_CREATE_CONFIGURATION = AgentConfigurationSchema.parse({
  permission_mode: 'bypassPermissions',
  max_turns: 100,
  env_vars: {},
  soul_enabled: true,
  scheduler_enabled: false,
  scheduler_type: 'interval',
  heartbeat_enabled: true,
  heartbeat_interval: 30
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const stringWithFallback = (value: unknown, fallback: string): string => {
  return typeof value === 'string' ? value : fallback
}

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

const optionalStringArray = (value: unknown): string[] | undefined => {
  const normalized = stringArray(value)
  return normalized.length > 0 ? normalized : undefined
}

const finiteNumber = (value: unknown, fallback?: number): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const optionalBoolean = (value: unknown, fallback?: boolean): boolean | undefined => {
  return typeof value === 'boolean' ? value : fallback
}

const normalizeEnvVars = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export const parseAgentModalConfiguration = (value: unknown): AgentConfiguration => {
  const raw = isRecord(value) ? value : {}
  const permissionMode = PermissionModeSchema.safeParse(raw.permission_mode)
  const schedulerType = SchedulerTypeSchema.safeParse(raw.scheduler_type)

  const candidate = {
    ...DEFAULT_CREATE_CONFIGURATION,
    ...raw,
    avatar: optionalString(raw.avatar),
    slash_commands: optionalStringArray(raw.slash_commands),
    permission_mode: permissionMode.success ? permissionMode.data : DEFAULT_CREATE_CONFIGURATION.permission_mode,
    max_turns: finiteNumber(raw.max_turns, DEFAULT_CREATE_CONFIGURATION.max_turns),
    env_vars: normalizeEnvVars(raw.env_vars),
    soul_enabled: optionalBoolean(raw.soul_enabled, DEFAULT_CREATE_CONFIGURATION.soul_enabled),
    bootstrap_completed: optionalBoolean(raw.bootstrap_completed),
    scheduler_enabled: optionalBoolean(raw.scheduler_enabled, DEFAULT_CREATE_CONFIGURATION.scheduler_enabled),
    scheduler_type: schedulerType.success ? schedulerType.data : DEFAULT_CREATE_CONFIGURATION.scheduler_type,
    scheduler_cron: optionalString(raw.scheduler_cron),
    scheduler_interval: finiteNumber(raw.scheduler_interval),
    scheduler_one_time_delay: finiteNumber(raw.scheduler_one_time_delay),
    scheduler_last_run: optionalString(raw.scheduler_last_run),
    heartbeat_enabled: optionalBoolean(raw.heartbeat_enabled, DEFAULT_CREATE_CONFIGURATION.heartbeat_enabled),
    heartbeat_interval: finiteNumber(raw.heartbeat_interval, DEFAULT_CREATE_CONFIGURATION.heartbeat_interval)
  }

  const parsed = AgentConfigurationSchema.safeParse(candidate)
  return parsed.success ? parsed.data : DEFAULT_CREATE_CONFIGURATION
}

const getInitialAgentInstructions = (existing?: AgentWithTools): string => {
  const name = stringWithFallback(existing?.name, CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME)
  const instructions = optionalString(existing?.instructions)?.trim()

  if (!instructions || isLegacyAgentDefaultInstructions(instructions)) {
    return buildCherryStudioPiAgentInstructions(name)
  }

  return instructions
}

export const buildAgentForm = (existing?: AgentWithTools): BaseAgentForm => ({
  type: isAgentType(existing?.type) ? existing.type : 'claude-code',
  name: stringWithFallback(existing?.name, CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME),
  description: optionalString(existing?.description),
  instructions: getInitialAgentInstructions(existing),
  model: stringWithFallback(existing?.model, ''),
  accessible_paths: stringArray(existing?.accessible_paths),
  allowed_tools: stringArray(existing?.allowed_tools),
  mcps: stringArray(existing?.mcps),
  configuration: parseAgentModalConfiguration(existing?.configuration)
})
