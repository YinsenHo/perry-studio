import { describe, expect, it } from 'vitest'

import { PiStreamState } from '../transform'

const assistantMessage = (content: any[]) =>
  ({
    role: 'assistant',
    content,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop'
  }) as any

const assistantMessageWithUsage = (output: number, stopReason = 'stop') =>
  ({
    role: 'assistant',
    content: [],
    usage: {
      input: 10,
      output,
      cacheRead: 1,
      cacheWrite: 2,
      totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason
  }) as any

describe('PiStreamState', () => {
  it('suppresses reasoning chunks unless explicitly enabled', () => {
    const state = new PiStreamState('session-1')
    const chunks = state.transform({
      type: 'message_update',
      message: assistantMessage([{ type: 'thinking', thinking: '' }]),
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'private reasoning'
      }
    } as any)

    expect(chunks).toEqual([{ type: 'start-step', request: { body: '' }, warnings: [] }])
  })

  it('emits reasoning chunks when thinking is enabled', () => {
    const state = new PiStreamState('session-1', { emitReasoning: true })
    state.transform({
      type: 'message_update',
      message: assistantMessage([{ type: 'thinking', thinking: '' }]),
      assistantMessageEvent: {
        type: 'thinking_start',
        contentIndex: 0
      }
    } as any)

    const chunks = state.transform({
      type: 'message_update',
      message: assistantMessage([{ type: 'thinking', thinking: 'visible' }]),
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'visible'
      }
    } as any)

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'reasoning-delta',
        text: 'visible'
      })
    )
  })

  it('uses monotonic ids for fallback text across turns', () => {
    const state = new PiStreamState('session-1')
    const first = state.transform({
      type: 'turn_end',
      message: assistantMessage([{ type: 'text', text: 'first' }]),
      toolResults: []
    } as any)
    state.transform({ type: 'turn_start' } as any)
    const second = state.transform({
      type: 'turn_end',
      message: assistantMessage([{ type: 'text', text: 'second' }]),
      toolResults: []
    } as any)

    expect(first.find((chunk: any) => chunk.type === 'text-start')?.id).toBe('session-1:fallback-text:0')
    expect(second.find((chunk: any) => chunk.type === 'text-start')?.id).toBe('session-1:fallback-text:1')
  })

  it('emits final finish only on agent_end and aggregates turn usage', () => {
    const state = new PiStreamState('session-1')

    const firstTurn = state.transform({
      type: 'turn_end',
      message: assistantMessageWithUsage(5, 'toolUse'),
      toolResults: []
    } as any)
    const secondTurn = state.transform({
      type: 'turn_end',
      message: assistantMessageWithUsage(7),
      toolResults: []
    } as any)
    const final = state.transform({
      type: 'agent_end',
      messages: []
    } as any)

    expect(firstTurn.some((chunk: any) => chunk.type === 'finish')).toBe(false)
    expect(secondTurn.some((chunk: any) => chunk.type === 'finish')).toBe(false)
    expect(final).toContainEqual(
      expect.objectContaining({
        type: 'finish',
        finishReason: 'stop',
        totalUsage: expect.objectContaining({
          inputTokens: 20,
          outputTokens: 12,
          totalTokens: 32
        })
      })
    )
  })
})
