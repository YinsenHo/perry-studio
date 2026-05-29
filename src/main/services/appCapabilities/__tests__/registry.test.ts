import { describe, expect, it } from 'vitest'

import { AppCapabilityRegistry } from '../registry'
import type { AppCapabilityDefinition } from '../types'

const capability = (overrides: Partial<AppCapabilityDefinition>): AppCapabilityDefinition => ({
  id: 'settings.read',
  domain: 'settings',
  kind: 'query',
  title: 'Read settings',
  description: 'Read app settings',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  execute: async () => ({ ok: true, summary: 'ok' }),
  ...overrides
})

describe('AppCapabilityRegistry', () => {
  it('registers, lists, and hides schemas by default', () => {
    const registry = new AppCapabilityRegistry()
    registry.register(capability({ id: 'settings.read' }))

    const descriptors = registry.list()

    expect(descriptors).toEqual([expect.objectContaining({ id: 'settings.read', domain: 'settings' })])
    expect(descriptors[0]).not.toHaveProperty('inputSchema')
  })

  it('searches by aliases and ranks matching capabilities', () => {
    const registry = new AppCapabilityRegistry()
    registry.register(capability({ id: 'settings.read', aliases: ['preferences'] }))
    registry.register(
      capability({
        id: 'storage.backup.create',
        domain: 'storage',
        kind: 'command',
        title: 'Create local backup',
        description: 'Create a local backup',
        risk: 'write',
        tags: ['backup', 'data']
      })
    )

    expect(registry.search({ query: 'local backup' }).map((item) => item.id)).toEqual(['storage.backup.create'])
    expect(registry.search({ query: 'preferences' }).map((item) => item.id)).toEqual(['settings.read'])
  })

  it('filters by domain and can include schemas', () => {
    const registry = new AppCapabilityRegistry()
    registry.register(capability({ id: 'settings.read' }))
    registry.register(capability({ id: 'notes.list', domain: 'notes', title: 'List notes' }))

    expect(registry.list({ domain: 'notes', includeSchemas: true })).toEqual([
      expect.objectContaining({
        id: 'notes.list',
        inputSchema: { type: 'object', properties: {} }
      })
    ])
  })

  it('expands common Chinese product intents before scoring', () => {
    const registry = new AppCapabilityRegistry()
    registry.register(capability({ id: 'settings.read' }))
    registry.register(
      capability({
        id: 'storage.backup.create',
        domain: 'storage',
        kind: 'command',
        title: 'Create local backup',
        description: 'Create a local backup',
        risk: 'write',
        tags: ['backup', 'data']
      })
    )
    registry.register(
      capability({
        id: 'paintings.image.generate',
        domain: 'paintings',
        kind: 'command',
        title: 'Generate image',
        description: 'Generate an image',
        risk: 'external',
        tags: ['image', 'drawing']
      })
    )

    expect(registry.search({ query: '创建一个本地备份' }).map((item) => item.id)[0]).toBe('storage.backup.create')
    expect(registry.search({ query: '帮我画图' }).map((item) => item.id)[0]).toBe('paintings.image.generate')
  })
})
