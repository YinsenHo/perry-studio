import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deletePhrase: vi.fn(),
  flush: vi.fn(),
  scheduleDelete: vi.fn(),
  scheduleRow: vi.fn(),
  toArray: vi.fn(),
  updatePhrase: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    quick_phrases: {
      delete: mocks.deletePhrase,
      toArray: mocks.toArray,
      update: mocks.updatePhrase
    }
  }
}))

vi.mock('../StorageV2DexieTableMirrorService', () => ({
  storageV2DexieTableMirrorService: {
    flush: mocks.flush,
    scheduleDelete: mocks.scheduleDelete,
    scheduleRow: mocks.scheduleRow
  }
}))

vi.mock('../StorageV2DexieTableRecoveryService', () => ({
  storageV2DexieTableRecoveryService: {
    projectTableIfEmpty: vi.fn()
  }
}))

describe('QuickPhraseService', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('mirrors reordered quick phrases after a delete', async () => {
    mocks.toArray.mockResolvedValue([
      { id: 'phrase-b', title: 'B', content: 'B', order: 1 },
      { id: 'phrase-a', title: 'A', content: 'A', order: 2 }
    ])
    mocks.deletePhrase.mockResolvedValue(undefined)
    mocks.updatePhrase.mockResolvedValue(1)
    mocks.flush.mockResolvedValue(undefined)

    const { default: QuickPhraseService } = await import('../QuickPhraseService')

    await QuickPhraseService.delete('phrase-removed')

    expect(mocks.scheduleDelete).toHaveBeenCalledWith('quick_phrases', 'phrase-removed')
    expect(mocks.updatePhrase).toHaveBeenNthCalledWith(1, 'phrase-a', { order: 1 })
    expect(mocks.updatePhrase).toHaveBeenNthCalledWith(2, 'phrase-b', { order: 0 })
    expect(mocks.scheduleRow).toHaveBeenCalledWith('quick_phrases', 'phrase-a', 0)
    expect(mocks.scheduleRow).toHaveBeenCalledWith('quick_phrases', 'phrase-b', 0)
    expect(mocks.flush).toHaveBeenCalled()
  })
})
