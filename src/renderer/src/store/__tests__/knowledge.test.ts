import knowledgeReducer, { deleteBase, type KnowledgeState } from '@renderer/store/knowledge'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('knowledge slice', () => {
  const knowledgeBaseDelete = vi.fn()

  beforeEach(() => {
    knowledgeBaseDelete.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        knowledgeBase: {
          delete: knowledgeBaseDelete
        }
      }
    })
  })

  it('removes a base without running async deletion side effects from the reducer', () => {
    const state = {
      bases: [
        {
          id: 'base-1',
          name: 'Docs',
          items: [
            {
              id: 'item-1',
              type: 'file',
              content: { id: 'file-1', name: 'file-1.pdf' }
            }
          ]
        }
      ]
    } as unknown as KnowledgeState

    const next = knowledgeReducer(state, deleteBase({ baseId: 'base-1' }))

    expect(next.bases).toEqual([])
    expect(knowledgeBaseDelete).not.toHaveBeenCalled()
  })
})
