import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type {
  Api,
  ImageContent,
  Message as PiMessage,
  Model as PiModel,
  SimpleStreamOptions,
  UserMessage
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai'
import { loggerService } from '@logger'
import { validateModelId } from '@main/apiServer/utils'
import { agentMessageRepository } from '@main/services/agents/database/sessionMessageRepository'
import { getProxyEnvironment } from '@main/services/proxy/nodeProxy'
import {
  buildCherryStudioPiAgentInstructions,
  CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME,
  isDefaultCherryStudioPiAgentInstructions,
  normalizeAgentInstructions
} from '@shared/agents/pi/constants'
import { formatApiHost, hasAPIVersion, withoutTrailingApiVersion, withoutTrailingSlash } from '@shared/utils'
import type { AgentPersistedMessage, MessageBlock, Model, Provider } from '@types'

import type {
  AgentServiceInterface,
  AgentStream,
  AgentStreamEvent,
  AgentThinkingOptions
} from '../../interfaces/AgentStreamInterface'
import { promptForToolApproval } from '../claudecode/tool-permissions'
import { createPiMcpTools, createPiTools } from './tools'
import { PiStreamState } from './transform'

const logger = loggerService.withContext('PiAgentService')

const NO_KEY_PLACEHOLDERS: Record<string, string> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio'
}

const PROVIDER_API_MAP = {
  anthropic: 'anthropic-messages',
  'vertex-anthropic': 'anthropic-messages',
  gemini: 'google-generative-ai',
  vertexai: 'google-vertex',
  mistral: 'mistral-conversations',
  'aws-bedrock': 'bedrock-converse-stream',
  'openai-response': 'openai-responses',
  'azure-openai': 'azure-openai-responses'
} satisfies Partial<Record<Provider['type'], Api>>

const ENDPOINT_API_MAP = {
  anthropic: 'anthropic-messages',
  gemini: 'google-generative-ai',
  openai: 'openai-completions',
  'openai-response': 'openai-responses'
} satisfies Partial<Record<NonNullable<Model['endpoint_type']>, Api>>

const MAX_HYDRATED_HISTORY_MESSAGES = 80

class PiAgentStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  sdkSessionId?: string
}

type CachedAgent = {
  key: string
  agent: Agent
}

class PiAgentService implements AgentServiceInterface {
  private readonly agents = new Map<string, CachedAgent>()

  async invoke(
    prompt: string,
    session: Parameters<AgentServiceInterface['invoke']>[1],
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<AgentStream> {
    const stream = new PiAgentStream()
    stream.sdkSessionId = `pi:${session.id}`

    const cwd = session.accessible_paths[0]
    if (!cwd) {
      stream.emit('data', { type: 'error', error: new Error('No accessible paths defined for the agent session') })
      return stream
    }

    const modelInfo = await validateModelId(session.model)
    if (!modelInfo.valid || !modelInfo.provider || !modelInfo.modelId) {
      stream.emit('data', {
        type: 'error',
        error: new Error(`Invalid model ID '${session.model}': ${JSON.stringify(modelInfo.error)}`)
      })
      return stream
    }

    const piModel = this.toPiModel(modelInfo.provider, modelInfo.modelId)
    const apiKey = await this.resolveApiKey(modelInfo.provider)
    const sessionKey = this.buildSessionKey({
      api: piModel.api,
      apiKeyHash: this.hashSecret(apiKey),
      baseUrl: piModel.baseUrl,
      cwd,
      instructions: session.instructions,
      name: this.getAgentDisplayName(session.name),
      model: session.model,
      permissionMode: session.configuration?.permission_mode,
      paths: session.accessible_paths,
      mcps: session.mcps,
      thinking: this.mapThinkingLevel(thinkingOptions),
      tools: session.allowed_tools
    })

    const cached = this.agents.get(session.id)
    const agent =
      cached?.key === sessionKey
        ? cached.agent
        : await this.createAgent({
            cwd,
            lastAgentSessionId,
            sessionId: session.id,
            sessionKey,
            session,
            model: piModel,
            apiKey,
            thinkingOptions
          })

    this.agents.set(session.id, { key: sessionKey, agent })

    const state = new PiStreamState(session.id, { emitReasoning: this.shouldEmitReasoning(thinkingOptions) })
    let completed = false
    const unsubscribe = agent.subscribe((event) => {
      for (const chunk of state.transform(event)) {
        stream.emit('data', { type: 'chunk', chunk })
      }
      if (event.type === 'agent_end') {
        completed = true
        stream.emit('data', { type: 'complete' })
      }
    })

    abortController.signal.addEventListener(
      'abort',
      () => {
        agent.abort()
        stream.emit('data', { type: 'cancelled' })
      },
      { once: true }
    )

    setImmediate(() => {
      agent
        .prompt(prompt, this.toPiImages(images))
        .catch((error) => {
          logger.error('Pi agent stream failed', error as Error)
          stream.emit('data', { type: 'error', error: error instanceof Error ? error : new Error(String(error)) })
        })
        .finally(() => {
          if (!completed) {
            completed = true
            stream.emit('data', { type: 'complete' })
          }
          unsubscribe()
        })
    })

    return stream
  }

  private async createAgent({
    cwd,
    lastAgentSessionId,
    sessionId,
    sessionKey,
    session,
    model,
    apiKey,
    thinkingOptions
  }: {
    cwd: string
    lastAgentSessionId?: string
    sessionId: string
    sessionKey: string
    session: Parameters<AgentServiceInterface['invoke']>[1]
    model: PiModel<Api>
    apiKey: string
    thinkingOptions?: AgentThinkingOptions
  }) {
    logger.info('Creating Pi agent runtime', {
      sessionId,
      sessionKey,
      cwd,
      model: model.id,
      provider: model.provider,
      resumed: Boolean(lastAgentSessionId)
    })

    const tools = [...createPiTools(cwd, session.accessible_paths), ...(await createPiMcpTools(session.mcps))]
    const allowedToolSet = new Set(session.allowed_tools ?? [])
    const configuredTools =
      allowedToolSet.size > 0
        ? tools.filter((tool) => allowedToolSet.has(tool.name) || allowedToolSet.has(tool.label))
        : tools
    const systemPrompt = this.buildSystemPrompt(session, configuredTools)
    const permissionMode = session.configuration?.permission_mode
    const history = await this.loadHistory(session.id)

    return new Agent({
      initialState: {
        systemPrompt,
        messages: history,
        model,
        tools: configuredTools,
        thinkingLevel: this.mapThinkingLevel(thinkingOptions)
      },
      streamFn: async (activeModel, context, options) => {
        return streamSimple(activeModel, context, {
          ...options,
          apiKey,
          headers: this.mergeHeaders(activeModel, options)
        })
      },
      beforeToolCall: async ({ toolCall, args }, signal) => {
        if (permissionMode === 'plan') {
          return { block: true, reason: 'Tool execution is disabled in plan mode.' }
        }
        if (permissionMode === 'bypassPermissions') return undefined
        if (this.isReadOnlyTool(toolCall.name)) return undefined
        if (permissionMode === 'acceptEdits' && (toolCall.name === 'Edit' || toolCall.name === 'Write'))
          return undefined

        const approval = await promptForToolApproval(toolCall.name, args as Record<string, unknown>, {
          signal: signal ?? new AbortController().signal,
          toolCallId: `${sessionId}:${toolCall.id}`
        })

        if (approval.behavior === 'deny') {
          return { block: true, reason: approval.message ?? 'User denied permission for this tool' }
        }

        return undefined
      },
      afterToolCall: async ({ result, isError }) => {
        if (isError) return undefined
        if (result.details && typeof result.details === 'object' && 'isError' in result.details) {
          return { isError: (result.details as Record<string, unknown>).isError === true }
        }
        return undefined
      },
      toolExecution: 'sequential'
    })
  }

  private buildSystemPrompt(session: Parameters<AgentServiceInterface['invoke']>[1], tools: AgentTool<any>[]): string {
    const agentName = this.getAgentDisplayName(session.name)
    const identityPrompt = this.buildIdentityPrompt(agentName)
    const sessionInstructions = (session.instructions ?? '').trim()
    const hasDefaultIdentityInstructions = isDefaultCherryStudioPiAgentInstructions(sessionInstructions, agentName)
    const hasExtendedIdentityInstructions =
      normalizeAgentInstructions(sessionInstructions).startsWith(normalizeAgentInstructions(identityPrompt)) &&
      !hasDefaultIdentityInstructions

    return [
      hasExtendedIdentityInstructions ? sessionInstructions : identityPrompt,
      this.buildPiToolGuidance(tools),
      sessionInstructions && !hasDefaultIdentityInstructions && !hasExtendedIdentityInstructions
        ? sessionInstructions
        : undefined
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private buildIdentityPrompt(agentName: string): string {
    return buildCherryStudioPiAgentInstructions(agentName)
  }

  private getAgentDisplayName(name?: string | null): string {
    const normalized = (name ?? '').replace(/\s+/g, ' ').trim()
    return normalized || CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME
  }

  private buildPiToolGuidance(tools: AgentTool<any>[]): string {
    const mcpTools = tools.filter((tool) => tool.name.startsWith('mcp__'))
    const mcpSummary = mcpTools.length
      ? [
          'MCP tools are available and should be used when they are the best fit. Call only MCP tools listed in the actual tool schema.',
          'Available MCP tools:',
          ...mcpTools
            .slice(0, 40)
            .map((tool) => `- ${tool.name}: ${tool.description ? tool.description.slice(0, 160) : tool.label}`)
        ].join('\n')
      : 'No MCP tools are currently injected for this session. Do not call MCP/slash/browser tools unless they appear in the actual tool schema.'

    return `## Tool Use

Available built-in tools are Bash, Read, Write, Edit, Glob, and Grep.

${mcpSummary}

Use the least expensive tool first:
- Use Glob/Grep to locate files or symbols before broad Read calls.
- For skill discovery, start with Glob pattern ".claude/skills/*/SKILL.md" from the workspace root. Do not probe guessed skill paths with failing Bash commands.
- Use Read with offset/limit for large files.
- Use Edit only after confirming the exact target text; if an edit is ambiguous, read more context and retry once.
- Batch related shell checks into one Bash command when safe, but make diagnostic checks tolerate misses (for example append "|| true") and avoid speculative commands.
- For dependency installs, inspect the package manager files first, then run the one matching install command. CLI packages may be installed with npm install -g; Cherry Studio Pi maps global npm installs to an agent-scoped tool prefix on PATH, so do not convert a CLI install into a project dependency. Prefer npm metadata/install for npm-distributed CLIs; do not try Homebrew unless the user explicitly asked for Homebrew. If an install script, binary download, or native package fetch fails because of SSL/certificate/network restrictions, stop. Do not manually download binaries with Node/curl/wget, do not switch to a local/global install workaround, and do not repeat variants. Briefly report the dependency/environment blocker only if it prevents the requested task.
- Path restrictions are final boundaries, not problems to bypass. If a path is outside accessible directories, do not retry from another directory, copy global files into the project, locally install a CLI as a workaround, or ask the user to expose /opt/homebrew/bin or /usr/local/bin. Use only the current workspace, injected MCP tools, or ask the user to add a task-relevant project path.
- Never repair or mutate system/global SSL, certificate, curl, keychain, trust-store, npm, git, or Node TLS settings. Do not run commands such as security add-trusted-cert, update-ca-certificates, brew reinstall ca-certificates, npm config set strict-ssl false, git config --global http.sslVerify false, or NODE_TLS_REJECT_UNAUTHORIZED=0. If curl reports an SSL/certificate problem while fetching public documentation, do not narrate that failure or try another downloader; continue only if package metadata or local knowledge is enough. Do not tell the user that Cherry Studio Pi, Node, or Homebrew is broadly sandbox-limited unless the exact requested action is still blocked after the single appropriate install path.
- Keep tool outputs small: prefer commands like rg, git status --short, and targeted test commands over full-directory dumps.`
  }

  private async loadHistory(sessionId: string): Promise<AgentMessage[]> {
    try {
      const persisted = await agentMessageRepository.getSessionHistory(sessionId)
      return persisted
        .slice(-MAX_HYDRATED_HISTORY_MESSAGES)
        .map((message) => this.toPiHistoryMessage(message))
        .filter((message): message is PiMessage => Boolean(message))
    } catch (error) {
      logger.warn('Failed to hydrate Pi agent history; continuing with an empty transcript', error as Error)
      return []
    }
  }

  private toPiHistoryMessage(message: AgentPersistedMessage): PiMessage | undefined {
    const role = message.message?.role
    const timestamp = message.message?.createdAt ? new Date(message.message.createdAt).getTime() : Date.now()

    if (role === 'user') {
      const content = this.blocksToUserContent(message.blocks)
      if (!content) return undefined
      return {
        role: 'user',
        content,
        timestamp
      }
    }

    if (role === 'assistant') {
      const text = this.blocksToText(message.blocks, ['main_text', 'compact'])
      if (!text) return undefined
      return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'openai-completions',
        provider: 'cherry-history',
        model: 'history',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp
      }
    }

    return undefined
  }

  private blocksToUserContent(blocks: MessageBlock[]): UserMessage['content'] {
    const content: Array<{ type: 'text'; text: string } | ImageContent> = []
    const text = this.blocksToText(blocks, ['main_text', 'compact'])
    if (text) {
      content.push({ type: 'text', text })
    }

    for (const block of blocks) {
      if (block.type !== 'image' || !('url' in block) || typeof block.url !== 'string') continue
      const match = block.url.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      content.push({ type: 'image', mimeType: match[1], data: match[2] })
    }

    if (content.length === 0) return ''
    if (content.length === 1 && content[0].type === 'text') return content[0].text
    return content
  }

  private blocksToText(blocks: MessageBlock[], blockTypes: string[]): string {
    return blocks
      .filter((block) => blockTypes.includes(block.type) && 'content' in block && typeof block.content === 'string')
      .map((block) => ('content' in block && typeof block.content === 'string' ? block.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }

  private toPiImages(images?: Array<{ data: string; media_type: string }>): ImageContent[] | undefined {
    if (!images?.length) return undefined
    return images.map((image) => ({
      type: 'image',
      data: image.data,
      mimeType: image.media_type
    }))
  }

  private async resolveApiKey(provider: Provider): Promise<string> {
    const apiKey = provider.apiKey ? provider.apiKey.split(',')[0].trim() : ''
    return apiKey || NO_KEY_PLACEHOLDERS[provider.id] || NO_KEY_PLACEHOLDERS[provider.type] || 'no-key-required'
  }

  private toPiModel(provider: Provider, modelId: string): PiModel<Api> {
    const cherryModel = provider.models.find((model) => model.id === modelId)
    const api = this.determineApi(provider, cherryModel)
    const baseUrl = this.getBaseUrl(provider, api)
    const pricing = cherryModel?.pricing

    return {
      id: modelId,
      name: cherryModel?.name || modelId,
      api,
      provider: `cherry-${provider.id}`,
      baseUrl,
      reasoning: this.hasCapability(cherryModel, 'reasoning'),
      input: this.hasCapability(cherryModel, 'vision') ? ['text', 'image'] : ['text'],
      cost: {
        input: pricing?.input_per_million_tokens ?? 0,
        output: pricing?.output_per_million_tokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 128_000,
      maxTokens: 16_384,
      headers: provider.extra_headers
    }
  }

  private determineApi(provider: Provider, model?: Model): Api {
    const providerApi = PROVIDER_API_MAP[provider.type]
    if (providerApi) return providerApi

    if (model?.endpoint_type) {
      const endpointApi = ENDPOINT_API_MAP[model.endpoint_type]
      if (endpointApi) return endpointApi
    }

    const supportedEndpointApi = model?.supported_endpoint_types
      ?.map((endpoint) => ENDPOINT_API_MAP[endpoint])
      .find((api): api is Api => Boolean(api))
    if (supportedEndpointApi) return supportedEndpointApi

    if (provider.anthropicApiHost && !model?.supported_endpoint_types?.length) return 'anthropic-messages'
    return 'openai-completions'
  }

  private getBaseUrl(provider: Provider, api: Api): string {
    if (api === 'anthropic-messages') {
      return withoutTrailingApiVersion(withoutTrailingSlash(provider.anthropicApiHost || provider.apiHost))
    }

    if (
      api === 'azure-openai-responses' ||
      api === 'google-generative-ai' ||
      api === 'google-vertex' ||
      api === 'mistral-conversations' ||
      api === 'bedrock-converse-stream'
    ) {
      return withoutTrailingSlash(provider.apiHost)
    }

    const raw = withoutTrailingSlash(provider.apiHost)
    if (provider.id === 'copilot' || provider.id === 'github') return formatApiHost(raw, false)
    if (provider.type === 'gateway' && raw.endsWith('/v1/ai')) return raw.replace(/\/v1\/ai$/, '/v1')
    return hasAPIVersion(raw) ? raw : `${raw}/v1`
  }

  private hasCapability(model: Model | undefined, capability: string): boolean {
    return Boolean(model?.capabilities?.some((item) => item.type === capability && item.isUserSelected !== false))
  }

  private mapThinkingLevel(thinkingOptions?: AgentThinkingOptions) {
    const effort = thinkingOptions?.effort
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
      return effort
    }
    return this.shouldEmitReasoning(thinkingOptions) ? 'medium' : 'off'
  }

  private shouldEmitReasoning(thinkingOptions?: AgentThinkingOptions): boolean {
    const thinking = thinkingOptions?.thinking
    return thinking?.type === 'enabled' || thinking?.type === 'adaptive'
  }

  private mergeHeaders(model: PiModel<Api>, options?: SimpleStreamOptions): Record<string, string> | undefined {
    const proxyEnv = getProxyEnvironment(process.env)
    const headers = { ...model.headers, ...options?.headers }
    if (Object.keys(proxyEnv).length > 0) {
      Object.assign(process.env, proxyEnv)
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  private isReadOnlyTool(toolName: string): boolean {
    return toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep'
  }

  private buildSessionKey(value: Record<string, unknown>): string {
    return JSON.stringify(value)
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex')
  }
}

export default PiAgentService
