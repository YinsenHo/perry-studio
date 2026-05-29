import { storageV2Service } from '@main/services/storageV2/StorageService'

import type { AppCapabilityDefinition } from '../types'
import { okResult, sanitizeForAgent } from '../utils'

export function createStorageCapabilities(): AppCapabilityDefinition[] {
  return [
    {
      id: 'storage.dataRoot.get',
      domain: 'storage',
      kind: 'query',
      title: 'Get data root',
      description: 'Return the active Storage v2 data root.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'data', 'path'],
      execute: async () => okResult('Storage data root read', { dataRoot: storageV2Service.getDataRoot() })
    },
    {
      id: 'storage.health.check',
      domain: 'storage',
      kind: 'query',
      title: 'Check storage health',
      description: 'Run a Storage v2 health check.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'health', 'database'],
      execute: async () => okResult('Storage health checked', sanitizeForAgent(await storageV2Service.healthCheck()))
    },
    {
      id: 'storage.stats.get',
      domain: 'storage',
      kind: 'query',
      title: 'Get storage statistics',
      description: 'Read Storage v2 statistics such as entity counts.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'stats', 'database'],
      execute: async () => okResult('Storage statistics read', sanitizeForAgent(await storageV2Service.getStats()))
    },
    {
      id: 'storage.backup.create',
      domain: 'storage',
      kind: 'command',
      title: 'Create local backup',
      description: 'Create a local Storage v2 backup of user data.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason stored in backup metadata' }
        }
      },
      risk: 'write',
      permissions: ['storage.backup.write'],
      sideEffects: ['filesystem.write'],
      tags: ['storage', 'backup', 'local', 'data'],
      examples: ['Create a local backup', 'Back up my data before changing settings'],
      execute: async (input: any) => {
        const backup = await storageV2Service.createBackup(String(input?.reason || 'agent-request'))
        return {
          ok: true,
          summary: `Backup created: ${backup.path}`,
          data: sanitizeForAgent(backup),
          artifacts: [{ type: 'backup', path: backup.path, title: 'Storage v2 backup' }]
        }
      }
    },
    {
      id: 'storage.backup.overview',
      domain: 'storage',
      kind: 'query',
      title: 'Get backup overview',
      description: 'List recent Storage v2 backups and backup overview information.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'backup', 'list'],
      execute: async () =>
        okResult('Backup overview read', sanitizeForAgent(await storageV2Service.getBackupOverview()))
    },
    {
      id: 'storage.backup.validate',
      domain: 'storage',
      kind: 'query',
      title: 'Validate backup',
      description: 'Validate that a Storage v2 backup path is restorable.',
      inputSchema: {
        type: 'object',
        properties: {
          backupPath: { type: 'string', description: 'Path to a Storage v2 backup directory' }
        },
        required: ['backupPath']
      },
      risk: 'read',
      tags: ['storage', 'backup', 'validate'],
      execute: async (input: any) =>
        okResult('Backup validated', sanitizeForAgent(await storageV2Service.validateBackup(String(input?.backupPath))))
    },
    {
      id: 'storage.backup.restore',
      domain: 'storage',
      kind: 'command',
      title: 'Restore backup',
      description: 'Restore a Storage v2 backup. This replaces local application data and is destructive.',
      inputSchema: {
        type: 'object',
        properties: {
          backupPath: { type: 'string', description: 'Path to a Storage v2 backup directory' }
        },
        required: ['backupPath']
      },
      risk: 'destructive',
      permissions: ['storage.backup.restore'],
      sideEffects: ['database.write', 'filesystem.write'],
      tags: ['storage', 'backup', 'restore'],
      execute: async (input: any, context) => {
        if (context.dryRun) {
          return okResult('Backup restore dry run completed', {
            validation: sanitizeForAgent(await storageV2Service.validateBackup(String(input?.backupPath)))
          })
        }
        return okResult(
          'Backup restored',
          sanitizeForAgent(await storageV2Service.restoreBackup(String(input?.backupPath)))
        )
      }
    },
    {
      id: 'storage.snapshot.create',
      domain: 'storage',
      kind: 'command',
      title: 'Create storage snapshot',
      description: 'Create a Storage v2 database snapshot for diagnostics or migrations.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason stored in snapshot metadata' }
        }
      },
      risk: 'write',
      permissions: ['storage.snapshot.write'],
      tags: ['storage', 'snapshot', 'database'],
      execute: async (input: any) =>
        okResult('Storage snapshot created', sanitizeForAgent(await storageV2Service.createSnapshot(input?.reason)))
    },
    {
      id: 'storage.providers.list',
      domain: 'storage',
      kind: 'query',
      title: 'List model providers',
      description: 'List model provider records from Storage v2 with secrets redacted.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'models', 'providers', 'settings'],
      execute: async () => okResult('Providers listed', sanitizeForAgent(await storageV2Service.listProviders()))
    },
    {
      id: 'storage.assistants.list',
      domain: 'storage',
      kind: 'query',
      title: 'List assistants',
      description: 'List assistant records from Storage v2.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'assistants'],
      execute: async () => okResult('Assistants listed', sanitizeForAgent(await storageV2Service.listAssistants()))
    },
    {
      id: 'storage.conversations.list',
      domain: 'storage',
      kind: 'query',
      title: 'List conversations',
      description: 'List conversation records from Storage v2.',
      inputSchema: {
        type: 'object',
        properties: {
          ownerType: { type: 'string' },
          ownerId: { type: 'string' }
        }
      },
      risk: 'read',
      tags: ['storage', 'conversations', 'chat'],
      execute: async (input: any) =>
        okResult(
          'Conversations listed',
          sanitizeForAgent(
            await storageV2Service.listConversations({
              ownerType: input?.ownerType,
              ownerId: input?.ownerId
            })
          )
        )
    },
    {
      id: 'storage.messages.list',
      domain: 'storage',
      kind: 'query',
      title: 'List conversation messages',
      description: 'List messages for a Storage v2 conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' }
        },
        required: ['conversationId']
      },
      risk: 'read',
      tags: ['storage', 'messages', 'conversations', 'chat'],
      execute: async (input: any) =>
        okResult(
          'Conversation messages listed',
          sanitizeForAgent(
            await storageV2Service.listMessages(String(input?.conversationId), {
              limit: input?.limit,
              offset: input?.offset
            })
          )
        )
    },
    {
      id: 'storage.files.list',
      domain: 'storage',
      kind: 'query',
      title: 'List files',
      description: 'List file records from Storage v2.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['storage', 'files'],
      execute: async () => okResult('Files listed', sanitizeForAgent(await storageV2Service.listFiles()))
    },
    {
      id: 'storage.file.get',
      domain: 'storage',
      kind: 'query',
      title: 'Get file record',
      description: 'Read one file record from Storage v2 by file id.',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string' }
        },
        required: ['fileId']
      },
      risk: 'read',
      tags: ['storage', 'files', 'read'],
      execute: async (input: any) =>
        okResult('File record read', sanitizeForAgent(await storageV2Service.getFile(String(input?.fileId))))
    }
  ]
}
