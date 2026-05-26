import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { FinishReason, LanguageModelUsage } from 'ai'

type AgentStreamPart = any

const emptyUsage: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0
  },
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined
  }
}

const mapUsage = (usage?: Usage): LanguageModelUsage => {
  if (!usage) return { ...emptyUsage }

  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    inputTokenDetails: {
      noCacheTokens: usage.input,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined
    },
    raw: usage as any
  }
}

const addUsage = (current: LanguageModelUsage, next: LanguageModelUsage): LanguageModelUsage => ({
  inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
  outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
  totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
  inputTokenDetails: {
    noCacheTokens: (current.inputTokenDetails?.noCacheTokens ?? 0) + (next.inputTokenDetails?.noCacheTokens ?? 0),
    cacheReadTokens: (current.inputTokenDetails?.cacheReadTokens ?? 0) + (next.inputTokenDetails?.cacheReadTokens ?? 0),
    cacheWriteTokens:
      (current.inputTokenDetails?.cacheWriteTokens ?? 0) + (next.inputTokenDetails?.cacheWriteTokens ?? 0)
  },
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined
  }
})

const mapFinishReason = (reason?: AssistantMessage['stopReason']): FinishReason => {
  switch (reason) {
    case 'length':
      return 'length'
    case 'toolUse':
      return 'tool-calls'
    case 'error':
      return 'error'
    case 'aborted':
      return 'other'
    case 'stop':
    default:
      return 'stop'
  }
}

const textFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text
        }
        if (item && typeof item === 'object' && 'type' in item && item.type === 'image') {
          return '[image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  return typeof content === 'object' ? JSON.stringify(content) : String(content)
}

export class PiStreamState {
  private readonly sessionId: string
  private readonly emitReasoning: boolean
  private readonly textIds = new Map<number, string>()
  private readonly reasoningIds = new Map<number, string>()
  private readonly toolInputs = new Map<string, unknown>()
  private emittedTextByTurn = ''
  private stepActive = false
  private fallbackTextIndex = 0
  private totalUsage: LanguageModelUsage = { ...emptyUsage }
  private finishReason: FinishReason = 'stop'

  constructor(sessionId: string, options: { emitReasoning?: boolean } = {}) {
    this.sessionId = sessionId
    this.emitReasoning = options.emitReasoning === true
  }

  transform(event: AgentEvent): AgentStreamPart[] {
    switch (event.type) {
      case 'agent_start':
        this.totalUsage = { ...emptyUsage }
        this.finishReason = 'stop'
        this.emittedTextByTurn = ''
        this.stepActive = false
        return []

      case 'turn_start':
        this.stepActive = true
        this.emittedTextByTurn = ''
        return [{ type: 'start-step', request: { body: '' }, warnings: [] } as AgentStreamPart]

      case 'message_update':
        return this.transformAssistantUpdate(event)

      case 'tool_execution_end':
        return [
          {
            type: event.isError ? 'tool-error' : 'tool-result',
            toolCallId: this.namespacedToolCallId(event.toolCallId),
            toolName: event.toolName,
            input: this.toolInputs.get(event.toolCallId),
            output: textFromContent(event.result?.content),
            providerMetadata: { pi: { raw: event } }
          } as AgentStreamPart
        ]

      case 'turn_end': {
        const message = event.message as AssistantMessage
        if (message.role !== 'assistant') return []
        const usage = mapUsage(message.usage)
        this.totalUsage = addUsage(this.totalUsage, usage)
        this.finishReason = mapFinishReason(message.stopReason)
        this.stepActive = false
        return [
          ...this.createFallbackTextChunks(message),
          {
            type: 'finish-step',
            finishReason: this.finishReason,
            usage,
            providerMetadata: { pi: { raw: message } }
          } as AgentStreamPart
        ]
      }

      case 'agent_end':
        return [
          {
            type: 'finish',
            finishReason: this.finishReason,
            totalUsage: this.totalUsage,
            providerMetadata: { pi: { raw: event.messages } }
          } as AgentStreamPart
        ]

      default:
        return []
    }
  }

  private transformAssistantUpdate(event: Extract<AgentEvent, { type: 'message_update' }>): AgentStreamPart[] {
    const assistantEvent = event.assistantMessageEvent
    const providerMetadata = { pi: { raw: assistantEvent } }
    const chunks: AgentStreamPart[] = []

    if (!this.stepActive) {
      this.stepActive = true
      this.emittedTextByTurn = ''
      chunks.push({ type: 'start-step', request: { body: '' }, warnings: [] } as AgentStreamPart)
    }

    switch (assistantEvent.type) {
      case 'text_start': {
        const id = this.blockId('text', assistantEvent.contentIndex)
        this.textIds.set(assistantEvent.contentIndex, id)
        chunks.push({ type: 'text-start', id, providerMetadata } as AgentStreamPart)
        break
      }
      case 'text_delta': {
        const id = this.textIds.get(assistantEvent.contentIndex) ?? this.blockId('text', assistantEvent.contentIndex)
        this.textIds.set(assistantEvent.contentIndex, id)
        this.emittedTextByTurn += assistantEvent.delta
        chunks.push({ type: 'text-delta', id, text: assistantEvent.delta, providerMetadata } as AgentStreamPart)
        break
      }
      case 'text_end': {
        const id = this.textIds.get(assistantEvent.contentIndex) ?? this.blockId('text', assistantEvent.contentIndex)
        chunks.push({
          type: 'text-end',
          id,
          providerMetadata: { ...providerMetadata, text: { value: assistantEvent.content } }
        } as AgentStreamPart)
        this.textIds.delete(assistantEvent.contentIndex)
        break
      }
      case 'thinking_start': {
        if (!this.emitReasoning) break
        const id = this.blockId('reasoning', assistantEvent.contentIndex)
        this.reasoningIds.set(assistantEvent.contentIndex, id)
        chunks.push({ type: 'reasoning-start', id, providerMetadata } as AgentStreamPart)
        break
      }
      case 'thinking_delta': {
        if (!this.emitReasoning) break
        const id =
          this.reasoningIds.get(assistantEvent.contentIndex) ?? this.blockId('reasoning', assistantEvent.contentIndex)
        this.reasoningIds.set(assistantEvent.contentIndex, id)
        chunks.push({ type: 'reasoning-delta', id, text: assistantEvent.delta, providerMetadata } as AgentStreamPart)
        break
      }
      case 'thinking_end': {
        if (!this.emitReasoning) break
        const id =
          this.reasoningIds.get(assistantEvent.contentIndex) ?? this.blockId('reasoning', assistantEvent.contentIndex)
        chunks.push({ type: 'reasoning-end', id, providerMetadata } as AgentStreamPart)
        this.reasoningIds.delete(assistantEvent.contentIndex)
        break
      }
      case 'toolcall_start': {
        const toolCall = this.getToolCallAt(event.message as AssistantMessage, assistantEvent.contentIndex)
        if (toolCall) {
          chunks.push({
            type: 'tool-input-start',
            id: this.namespacedToolCallId(toolCall.id),
            toolName: toolCall.name,
            providerMetadata
          } as AgentStreamPart)
        }
        break
      }
      case 'toolcall_delta': {
        const toolCall = this.getToolCallAt(event.message as AssistantMessage, assistantEvent.contentIndex)
        if (toolCall) {
          chunks.push({
            type: 'tool-input-delta',
            id: this.namespacedToolCallId(toolCall.id),
            delta: assistantEvent.delta,
            providerMetadata
          } as AgentStreamPart)
        }
        break
      }
      case 'toolcall_end': {
        const toolCall = assistantEvent.toolCall
        this.toolInputs.set(toolCall.id, toolCall.arguments)
        chunks.push({
          type: 'tool-input-end',
          id: this.namespacedToolCallId(toolCall.id),
          providerMetadata
        } as AgentStreamPart)
        chunks.push({
          type: 'tool-call',
          toolCallId: this.namespacedToolCallId(toolCall.id),
          toolName: toolCall.name,
          input: toolCall.arguments,
          providerMetadata
        } as AgentStreamPart)
        break
      }
      default:
        break
    }

    return chunks
  }

  private blockId(kind: string, index: number): string {
    return `${this.sessionId}:${kind}:${index}`
  }

  private createFallbackTextChunks(message: AssistantMessage): AgentStreamPart[] {
    const text = textFromContent(message.content).trimEnd()
    if (!text || this.emittedTextByTurn.trimEnd() === text) return []

    const id = this.blockId('fallback-text', this.fallbackTextIndex++)
    this.emittedTextByTurn += text
    return [
      { type: 'text-start', id, providerMetadata: { pi: { fallback: true } } } as AgentStreamPart,
      { type: 'text-delta', id, text, providerMetadata: { pi: { fallback: true } } } as AgentStreamPart,
      {
        type: 'text-end',
        id,
        providerMetadata: { pi: { fallback: true }, text: { value: text } }
      } as AgentStreamPart
    ]
  }

  private namespacedToolCallId(toolCallId: string): string {
    return `${this.sessionId}:${toolCallId}`
  }

  private getToolCallAt(message: AssistantMessage, contentIndex: number) {
    const block = message.content[contentIndex]
    return block?.type === 'toolCall' ? block : undefined
  }
}
