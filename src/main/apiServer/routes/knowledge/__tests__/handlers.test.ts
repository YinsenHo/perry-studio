import type { KnowledgeBase } from '@types'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ValidationRequest } from '../../agents/validators/zodValidator'

// Mock dependencies BEFORE importing handlers - no top-level variables
vi.mock('@main/services/ReduxService', () => ({
  reduxService: {
    select: vi.fn()
  }
}))

vi.mock('@main/services/KnowledgeService', () => ({
  default: {
    search: vi.fn()
  }
}))

vi.mock('@main/services/storageV2/StorageV2Repositories', () => ({
  storageV2KnowledgeRepository: {
    listBases: vi.fn()
  },
  storageV2ProviderRepository: {
    list: vi.fn(),
    listCredentialRefs: vi.fn()
  }
}))

vi.mock('@main/services/storageV2/SecretVaultService', () => ({
  storageV2SecretVaultService: {
    getSecret: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }))
  }
}))

// Import handlers AFTER mocks
import { getKnowledgeBase, listKnowledgeBases, searchKnowledge } from '../handlers'

// Helper to create mock KnowledgeBase
function createMockKnowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: 'kb-test-id',
    name: 'Test Knowledge Base',
    description: 'Test description',
    model: { id: 'text-embedding-3-small', provider: 'openai' },
    dimensions: 1536,
    chunkSize: 500,
    chunkOverlap: 50,
    documentCount: 10,
    version: 1,
    items: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides
  } as KnowledgeBase
}

describe('Knowledge Handlers', () => {
  let req: Partial<ValidationRequest>
  let res: Partial<Response>
  let jsonMock: ReturnType<typeof vi.fn>
  let statusMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    jsonMock = vi.fn()
    statusMock = vi.fn(() => ({ json: jsonMock }))

    req = {}
    res = {
      status: statusMock,
      json: jsonMock
    }

    vi.clearAllMocks()
    await mockStorageV2KnowledgeBases()
    await mockStorageV2Providers()
    await mockStorageV2Secret(null)
  })

  async function mockStorageV2KnowledgeBases(bases: KnowledgeBase[] = []) {
    const { storageV2KnowledgeRepository } = await import('@main/services/storageV2/StorageV2Repositories')
    ;(storageV2KnowledgeRepository.listBases as ReturnType<typeof vi.fn>).mockResolvedValue(bases)
  }

  async function mockStorageV2Providers(
    providers: Array<Record<string, unknown>> = [],
    credentialRefs: Map<string, Record<string, string>> = new Map()
  ) {
    const { storageV2ProviderRepository } = await import('@main/services/storageV2/StorageV2Repositories')
    ;(storageV2ProviderRepository.list as ReturnType<typeof vi.fn>).mockResolvedValue(providers)
    ;(storageV2ProviderRepository.listCredentialRefs as ReturnType<typeof vi.fn>).mockResolvedValue(credentialRefs)
  }

  async function mockStorageV2Secret(secret: string | null) {
    const { storageV2SecretVaultService } = await import('@main/services/storageV2/SecretVaultService')
    ;(storageV2SecretVaultService.getSecret as ReturnType<typeof vi.fn>).mockResolvedValue(secret)
  }

  describe('listKnowledgeBases', () => {
    it('should return paginated knowledge bases', async () => {
      const mockBases = [
        createMockKnowledgeBase({ id: 'kb-1', name: 'KB 1' }),
        createMockKnowledgeBase({ id: 'kb-2', name: 'KB 2' }),
        createMockKnowledgeBase({ id: 'kb-3', name: 'KB 3' })
      ]

      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue(mockBases)
      await mockStorageV2KnowledgeBases()

      req.validatedQuery = { limit: 2, offset: 0 }

      await listKnowledgeBases(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith({
        knowledge_bases: mockBases.slice(0, 2),
        total: 3
      })
    })

    it('should list knowledge bases from Storage v2 when Redux is unavailable', async () => {
      const mockBases = [createMockKnowledgeBase({ id: 'kb-storage-v2', name: 'Storage v2 KB' })]
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))
      await mockStorageV2KnowledgeBases(mockBases)

      req.validatedQuery = { limit: 20, offset: 0 }

      await listKnowledgeBases(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith({
        knowledge_bases: mockBases,
        total: 1
      })
      expect(statusMock).not.toHaveBeenCalled()
    })

    it('should list knowledge bases from Storage v2 when Redux cache is empty', async () => {
      const mockBases = [createMockKnowledgeBase({ id: 'kb-storage-v2', name: 'Storage v2 KB' })]
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue([])
      await mockStorageV2KnowledgeBases(mockBases)

      req.validatedQuery = { limit: 20, offset: 0 }

      await listKnowledgeBases(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith({
        knowledge_bases: mockBases,
        total: 1
      })
    })

    it('should return 503 when Redux is unavailable', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))
      await mockStorageV2KnowledgeBases()

      req.validatedQuery = { limit: 20, offset: 0 }

      await listKnowledgeBases(req as ValidationRequest, res as Response)

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({
        error: {
          message: 'Knowledge bases are only available when Cherry Studio window is open',
          type: 'service_unavailable',
          code: 'REDUX_UNAVAILABLE'
        }
      })
    })
  })

  describe('getKnowledgeBase', () => {
    it('should return a single knowledge base', async () => {
      const mockBase = createMockKnowledgeBase({ id: 'kb-1' })
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue([mockBase])
      await mockStorageV2KnowledgeBases()

      req.validatedParams = { id: 'kb-1' }

      await getKnowledgeBase(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith(mockBase)
    })

    it('should return a knowledge base from Storage v2 when Redux is unavailable', async () => {
      const mockBase = createMockKnowledgeBase({ id: 'kb-storage-v2' })
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))
      await mockStorageV2KnowledgeBases([mockBase])

      req.validatedParams = { id: 'kb-storage-v2' }

      await getKnowledgeBase(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith(mockBase)
      expect(statusMock).not.toHaveBeenCalled()
    })

    it('should return 404 when knowledge base not found', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue([])
      await mockStorageV2KnowledgeBases()

      req.validatedParams = { id: 'non-existent' }

      await getKnowledgeBase(req as ValidationRequest, res as Response)

      expect(statusMock).toHaveBeenCalledWith(404)
      expect(jsonMock).toHaveBeenCalledWith({
        error: {
          message: 'Knowledge base not found: non-existent',
          type: 'invalid_request_error',
          code: 'KB_NOT_FOUND'
        }
      })
    })

    it('should return 503 when Redux is unavailable', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))
      await mockStorageV2KnowledgeBases()

      req.validatedParams = { id: 'kb-1' }

      await getKnowledgeBase(req as ValidationRequest, res as Response)

      expect(statusMock).toHaveBeenCalledWith(503)
    })
  })

  describe('searchKnowledge', () => {
    it('should return warnings when no knowledge bases configured', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue([])

      req.validatedBody = { query: 'test query', document_count: 5 }

      await searchKnowledge(req as ValidationRequest, res as Response)

      expect(jsonMock).toHaveBeenCalledWith({
        query: 'test query',
        results: [],
        total: 0,
        searched_bases: [],
        warnings: ['No knowledge bases configured. Please add knowledge bases in Cherry Studio.']
      })
    })

    it('should return 404 when specified knowledge bases not found', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockResolvedValue([createMockKnowledgeBase({ id: 'kb-1' })])

      req.validatedBody = {
        query: 'test query',
        knowledge_base_ids: ['non-existent'],
        document_count: 5
      }

      await searchKnowledge(req as ValidationRequest, res as Response)

      expect(statusMock).toHaveBeenCalledWith(404)
      expect(jsonMock).toHaveBeenCalledWith({
        error: {
          message: 'None of the specified knowledge bases were found',
          type: 'invalid_request_error',
          code: 'KB_NOT_FOUND'
        }
      })
    })

    it('should return 503 when Redux is unavailable', async () => {
      const { reduxService } = await import('@main/services/ReduxService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))

      req.validatedBody = { query: 'test query', document_count: 5 }

      await searchKnowledge(req as ValidationRequest, res as Response)

      expect(statusMock).toHaveBeenCalledWith(503)
    })

    it('should search using Storage v2 knowledge bases and provider secrets when Redux is unavailable', async () => {
      const mockBase = createMockKnowledgeBase({
        id: 'kb-storage-v2',
        name: 'Storage v2 KB'
      })
      const { reduxService } = await import('@main/services/ReduxService')
      const { default: KnowledgeService } = await import('@main/services/KnowledgeService')
      ;(reduxService.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Main window is not available'))
      ;(KnowledgeService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
        { content: 'matched chunk', score: 0.87 }
      ])
      await mockStorageV2KnowledgeBases([mockBase])
      await mockStorageV2Providers(
        [
          {
            id: 'openai',
            type: 'openai',
            name: 'OpenAI',
            apiHost: 'https://api.openai.com/v1/#',
            enabled: true,
            sortOrder: 0,
            config: {},
            models: [],
            hasCredentialRef: true,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            deletedAt: null,
            version: 1
          }
        ],
        new Map([['openai', { apiKey: 'storage-v2://secret/provider/openai/apiKey' }]])
      )
      await mockStorageV2Secret('secret-key,secondary-key')

      req.validatedBody = { query: 'storage query', document_count: 5 }

      await searchKnowledge(req as ValidationRequest, res as Response)

      expect(statusMock).not.toHaveBeenCalled()
      expect(KnowledgeService.search).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          search: 'storage query',
          base: expect.objectContaining({
            id: 'kb-storage-v2',
            embedApiClient: {
              model: 'text-embedding-3-small',
              provider: 'openai',
              apiKey: 'secret-key',
              baseURL: 'https://api.openai.com/v1'
            }
          })
        })
      )
      expect(jsonMock).toHaveBeenCalledWith({
        query: 'storage query',
        results: [
          {
            content: 'matched chunk',
            score: 0.87,
            knowledge_base_id: 'kb-storage-v2',
            knowledge_base_name: 'Storage v2 KB'
          }
        ],
        total: 1,
        searched_bases: [{ id: 'kb-storage-v2', name: 'Storage v2 KB' }]
      })
    })
  })
})
