import { describe, expect, it } from 'vitest'

import { buildAgentForm, DEFAULT_CREATE_CONFIGURATION, parseAgentModalConfiguration } from '../agentForm'

describe('agent modal form helpers', () => {
  it('builds the default create form without requiring existing agent data', () => {
    const form = buildAgentForm()

    expect(form.type).toBe('claude-code')
    expect(form.name).toBe('Cherry Studio Pi Agent')
    expect(form.model).toBe('')
    expect(form.accessible_paths).toEqual([])
    expect(form.allowed_tools).toEqual([])
    expect(form.configuration?.permission_mode).toBe('bypassPermissions')
    expect(form.configuration?.soul_enabled).toBe(true)
  })

  it('normalizes malformed legacy agent fields instead of throwing during modal render', () => {
    const form = buildAgentForm({
      type: 'legacy-agent',
      name: 42,
      description: { text: 'bad' },
      instructions: { text: 'bad' },
      model: null,
      accessible_paths: { path: '/tmp' },
      allowed_tools: [1, 'Read', null],
      mcps: ['filesystem', 2],
      configuration: {
        permission_mode: 'danger',
        max_turns: '100',
        env_vars: null,
        soul_enabled: 'yes',
        scheduler_type: 'later',
        heartbeat_interval: '30'
      }
    } as any)

    expect(form.type).toBe('claude-code')
    expect(form.name).toBe('Cherry Studio Pi Agent')
    expect(form.description).toBeUndefined()
    expect(form.instructions).toContain('Cherry Studio Pi Agent')
    expect(form.model).toBe('')
    expect(form.accessible_paths).toEqual([])
    expect(form.allowed_tools).toEqual(['Read'])
    expect(form.mcps).toEqual(['filesystem'])
    expect(form.configuration).toMatchObject({
      permission_mode: DEFAULT_CREATE_CONFIGURATION.permission_mode,
      max_turns: DEFAULT_CREATE_CONFIGURATION.max_turns,
      env_vars: {},
      soul_enabled: DEFAULT_CREATE_CONFIGURATION.soul_enabled,
      scheduler_type: DEFAULT_CREATE_CONFIGURATION.scheduler_type,
      heartbeat_interval: DEFAULT_CREATE_CONFIGURATION.heartbeat_interval
    })
  })

  it('keeps valid configuration values and filters invalid env vars', () => {
    const config = parseAgentModalConfiguration({
      permission_mode: 'acceptEdits',
      max_turns: 12,
      env_vars: {
        API_KEY: 'secret',
        INVALID: 123
      },
      soul_enabled: false,
      scheduler_enabled: true,
      scheduler_type: 'cron',
      scheduler_cron: '0 * * * *',
      heartbeat_enabled: false,
      heartbeat_interval: 45
    })

    expect(config).toMatchObject({
      permission_mode: 'acceptEdits',
      max_turns: 12,
      env_vars: { API_KEY: 'secret' },
      soul_enabled: false,
      scheduler_enabled: true,
      scheduler_type: 'cron',
      scheduler_cron: '0 * * * *',
      heartbeat_enabled: false,
      heartbeat_interval: 45
    })
  })
})
