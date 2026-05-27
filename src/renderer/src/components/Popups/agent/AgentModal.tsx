import { loggerService } from '@logger'
import AnthropicProviderListPopover from '@renderer/components/AnthropicProviderListPopover'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import Scrollbar from '@renderer/components/Scrollbar'
import { HelpTooltip } from '@renderer/components/TooltipIcons'
import { TopView } from '@renderer/components/TopView'
import { permissionModeCards } from '@renderer/config/agent'
import { isWin } from '@renderer/config/constant'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useUpdateAgent } from '@renderer/hooks/agents/useUpdateAgent'
import SelectAgentBaseModelButton from '@renderer/pages/agents/components/SelectAgentBaseModelButton'
import { useAppDispatch } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import type {
  AddAgentForm,
  AgentEntity,
  ApiModel,
  BaseAgentForm,
  CreateSessionForm,
  PermissionMode,
  Tool,
  UpdateAgentForm
} from '@renderer/types'
import { AgentConfigurationSchema, isAgentType } from '@renderer/types'
import { parseKeyValueString, serializeKeyValueString } from '@renderer/utils/env'
import { getAnthropicSupportedProviders } from '@renderer/utils/provider'
import {
  buildCherryStudioPiAgentInstructions,
  CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME,
  isDefaultCherryStudioPiAgentInstructions,
  isLegacyAgentDefaultInstructions
} from '@shared/agents/pi/constants'
import type { GitBashPathInfo } from '@shared/config/constant'
import { Button, Input, Modal, Select, Switch } from 'antd'
import { CheckCircle2, ChevronLeft, Sparkles } from 'lucide-react'
import type { ChangeEvent, FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const { TextArea } = Input

const logger = loggerService.withContext('AddAgentPopup')

type AgentWithTools = AgentEntity & { tools?: Tool[] }
type WizardStep = 'identity' | 'instructions' | 'model' | 'capabilities'

const CREATE_STEPS: WizardStep[] = ['identity', 'instructions', 'model', 'capabilities']

const DEFAULT_CREATE_CONFIGURATION = AgentConfigurationSchema.parse({
  permission_mode: 'bypassPermissions',
  max_turns: 100,
  env_vars: {},
  soul_enabled: true,
  scheduler_enabled: false,
  scheduler_type: 'interval',
  heartbeat_enabled: true,
  heartbeat_interval: 30
})

const getInitialAgentInstructions = (existing?: AgentWithTools): string => {
  const name = existing?.name ?? CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME
  const instructions = existing?.instructions?.trim()

  if (!instructions || isLegacyAgentDefaultInstructions(instructions)) {
    return buildCherryStudioPiAgentInstructions(name)
  }

  return instructions
}

const buildAgentForm = (existing?: AgentWithTools): BaseAgentForm => ({
  type: existing?.type ?? 'claude-code',
  name: existing?.name ?? CHERRY_STUDIO_PI_AGENT_FALLBACK_NAME,
  description: existing?.description,
  instructions: getInitialAgentInstructions(existing),
  model: existing?.model ?? '',
  accessible_paths: existing?.accessible_paths ? [...existing.accessible_paths] : [],
  allowed_tools: existing?.allowed_tools ? [...existing.allowed_tools] : [],
  mcps: existing?.mcps ? [...existing.mcps] : [],
  configuration: AgentConfigurationSchema.parse(existing?.configuration ?? DEFAULT_CREATE_CONFIGURATION)
})

interface ShowParams {
  agent?: AgentWithTools
  afterSubmit?: (a: AgentEntity) => void
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ agent, afterSubmit, resolve }) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const loadingRef = useRef(false)
  const { addAgent } = useAgents()
  const { updateAgent } = useUpdateAgent()
  const client = useAgentClient()
  const dispatch = useAppDispatch()
  const isEditing = (agent?: AgentWithTools) => agent !== undefined

  const [form, setForm] = useState<BaseAgentForm>(() => buildAgentForm(agent))
  const [currentStep, setCurrentStep] = useState<WizardStep>('identity')
  const [createdAgent, setCreatedAgent] = useState<AgentEntity | null>(null)
  const [startingTask, setStartingTask] = useState(false)
  const [gitBashPathInfo, setGitBashPathInfo] = useState<GitBashPathInfo>({ path: null, source: null })

  useEffect(() => {
    if (open) {
      setForm(buildAgentForm(agent))
      setCurrentStep('identity')
      setCreatedAgent(null)
      setStartingTask(false)
    }
  }, [agent, open])

  const checkGitBash = useCallback(async () => {
    if (!isWin) return
    try {
      const pathInfo = await window.api.system.getGitBashPathInfo()
      setGitBashPathInfo(pathInfo)
    } catch (error) {
      logger.error('Failed to check Git Bash:', error as Error)
    }
  }, [])

  useEffect(() => {
    void checkGitBash()
  }, [checkGitBash])

  const selectedPermissionMode = form.configuration?.permission_mode ?? 'default'
  const stepIndex = CREATE_STEPS.indexOf(currentStep)
  const isLastStep = stepIndex === CREATE_STEPS.length - 1
  const isCreating = !isEditing(agent)
  const canGoNext =
    currentStep === 'identity'
      ? !!form.name.trim()
      : currentStep === 'model'
        ? !!form.model && (!isWin || !!gitBashPathInfo.path)
        : true

  const handlePickGitBash = useCallback(async () => {
    try {
      const selected = await window.api.file.select({
        title: t('agent.gitBash.pick.title', 'Select Git Bash executable'),
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        properties: ['openFile']
      })

      if (!selected || selected.length === 0) {
        return
      }

      const pickedPath = selected[0].path
      const ok = await window.api.system.setGitBashPath(pickedPath)
      if (!ok) {
        window.toast.error(
          t('agent.gitBash.pick.invalidPath', 'Selected file is not a valid Git Bash executable (bash.exe).')
        )
        return
      }

      await checkGitBash()
    } catch (error) {
      logger.error('Failed to pick Git Bash path', error as Error)
      window.toast.error(t('agent.gitBash.pick.failed', 'Failed to set Git Bash path'))
    }
  }, [checkGitBash, t])

  const handleResetGitBash = useCallback(async () => {
    try {
      // Clear manual setting and re-run auto-discovery
      await window.api.system.setGitBashPath(null)
      await checkGitBash()
    } catch (error) {
      logger.error('Failed to reset Git Bash path', error as Error)
    }
  }, [checkGitBash])

  const soulEnabled = form.configuration?.soul_enabled === true

  const onSoulModeChange = useCallback((checked: boolean) => {
    setForm((prev) => {
      const prevConfig = AgentConfigurationSchema.parse(prev.configuration ?? {})
      return {
        ...prev,
        configuration: {
          ...prevConfig,
          soul_enabled: checked,
          permission_mode: checked ? 'bypassPermissions' : prevConfig.permission_mode
        }
      }
    })
  }, [])

  const onPermissionModeChange = useCallback((value: PermissionMode) => {
    setForm((prev) => {
      const parsedConfiguration = AgentConfigurationSchema.parse(prev.configuration ?? {})
      if (parsedConfiguration.permission_mode === value) {
        if (!prev.configuration) {
          return {
            ...prev,
            configuration: parsedConfiguration
          }
        }
        return prev
      }

      const nextConfig = {
        ...parsedConfiguration,
        permission_mode: value
      }

      // Disable soul mode when switching away from bypassPermissions
      if (value !== 'bypassPermissions' && parsedConfiguration.soul_enabled === true) {
        nextConfig.soul_enabled = false
      }

      return {
        ...prev,
        configuration: nextConfig
      }
    })
  }, [])

  const onNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value
    setForm((prev) => ({
      ...prev,
      name,
      instructions:
        isDefaultCherryStudioPiAgentInstructions(prev.instructions, prev.name) ||
        isLegacyAgentDefaultInstructions(prev.instructions)
          ? buildCherryStudioPiAgentInstructions(name)
          : prev.instructions
    }))
  }, [])

  // const onDescChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
  //   setForm((prev) => ({
  //     ...prev,
  //     description: e.target.value
  //   }))
  // }, [])

  const onInstChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setForm((prev) => ({
      ...prev,
      instructions: e.target.value
    }))
  }, [])

  const [envVarsText, setEnvVarsText] = useState(() => serializeKeyValueString(form.configuration?.env_vars ?? {}))

  useEffect(() => {
    if (open) {
      setEnvVarsText(serializeKeyValueString(buildAgentForm(agent).configuration?.env_vars ?? {}))
    }
  }, [agent, open])

  const onEnvVarsChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setEnvVarsText(text)
    const parsed = parseKeyValueString(text)
    setForm((prev) => ({
      ...prev,
      configuration: {
        ...AgentConfigurationSchema.parse(prev.configuration ?? {}),
        env_vars: parsed
      }
    }))
  }, [])

  const addAccessiblePath = useCallback(async () => {
    try {
      const selected = await window.api.file.selectFolder()
      if (!selected) {
        return
      }
      setForm((prev) => {
        if (prev.accessible_paths.includes(selected)) {
          window.toast.warning(t('agent.session.accessible_paths.duplicate'))
          return prev
        }
        return {
          ...prev,
          accessible_paths: [...prev.accessible_paths, selected]
        }
      })
    } catch (error) {
      logger.error('Failed to select accessible path:', error as Error)
      window.toast.error(t('agent.session.accessible_paths.select_failed'))
    }
  }, [t])

  const removeAccessiblePath = useCallback((path: string) => {
    setForm((prev) => ({
      ...prev,
      accessible_paths: prev.accessible_paths.filter((item) => item !== path)
    }))
  }, [])

  // Create a temporary agentBase object for SelectAgentBaseModelButton
  const tempAgentBase: AgentEntity = useMemo(
    () => ({
      id: agent?.id ?? 'temp-creating',
      type: form.type,
      name: form.name,
      model: form.model,
      accessible_paths: form.accessible_paths.length > 0 ? form.accessible_paths : ['/'],
      allowed_tools: form.allowed_tools ?? [],
      description: form.description,
      instructions: form.instructions,
      configuration: form.configuration,
      created_at: agent?.created_at ?? new Date().toISOString(),
      updated_at: agent?.updated_at ?? new Date().toISOString()
    }),
    [form, agent?.id, agent?.created_at, agent?.updated_at]
  )

  const handleModelSelect = useCallback(async (model: ApiModel) => {
    setForm((prev) => ({ ...prev, model: model.id }))
  }, [])

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  const submitAgent = useCallback(async () => {
    if (loadingRef.current) return

    loadingRef.current = true

    if (!isAgentType(form.type)) {
      window.toast.error(t('agent.add.error.invalid_agent'))
      loadingRef.current = false
      return
    }
    if (!form.name.trim()) {
      window.toast.error(t('agent.add.error.name_required', 'Name is required'))
      loadingRef.current = false
      return
    }
    if (!form.model) {
      window.toast.error(t('error.model.not_exists'))
      loadingRef.current = false
      return
    }

    if (isWin && !gitBashPathInfo.path) {
      window.toast.error(t('agent.gitBash.error.required', 'Git Bash path is required on Windows'))
      loadingRef.current = false
      return
    }

    if (isEditing(agent)) {
      if (!agent) {
        loadingRef.current = false
        throw new Error('Agent is required for editing mode')
      }

      const updatePayload = {
        id: agent.id,
        name: form.name,
        description: form.description,
        instructions: form.instructions,
        model: form.model,
        accessible_paths: [...form.accessible_paths],
        allowed_tools: [...form.allowed_tools],
        configuration: form.configuration ? { ...form.configuration } : undefined
      } satisfies UpdateAgentForm

      const result = await updateAgent(updatePayload)
      if (result) {
        logger.debug('Updated agent', result)
        afterSubmit?.(result)
      } else {
        logger.error('Update failed.')
      }
      loadingRef.current = false
      setOpen(false)
      return
    }

    const newAgent = {
      type: form.type,
      name: form.name,
      description: form.description,
      instructions: form.instructions,
      model: form.model,
      accessible_paths: [...form.accessible_paths],
      allowed_tools: [...form.allowed_tools],
      configuration: form.configuration ? { ...form.configuration } : undefined
    } satisfies AddAgentForm
    const result = await addAgent(newAgent)

    if (!result.success) {
      loadingRef.current = false
      throw result.error
    }
    setCreatedAgent(result.data)
    afterSubmit?.(result.data)
    loadingRef.current = false
  }, [
    form.type,
    form.model,
    form.accessible_paths,
    form.name,
    form.description,
    form.instructions,
    form.allowed_tools,
    form.configuration,
    agent,
    t,
    updateAgent,
    afterSubmit,
    addAgent,
    gitBashPathInfo.path
  ])

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()

      if (!isLastStep) {
        if (!canGoNext) {
          if (currentStep === 'identity') {
            window.toast.error(t('agent.add.error.name_required', 'Name is required'))
          } else if (currentStep === 'model') {
            window.toast.error(!form.model ? t('error.model.not_exists') : t('agent.gitBash.error.required'))
          }
          return
        }
        setCurrentStep(CREATE_STEPS[stepIndex + 1])
        return
      }

      await submitAgent()
    },
    [canGoNext, currentStep, form.model, isLastStep, stepIndex, submitAgent, t]
  )

  const onBack = useCallback(() => {
    if (stepIndex > 0) {
      setCurrentStep(CREATE_STEPS[stepIndex - 1])
    }
  }, [stepIndex])

  const startTask = useCallback(async () => {
    if (!createdAgent || startingTask) return

    setStartingTask(true)
    try {
      const session = {
        ...createdAgent,
        id: undefined,
        name: t('common.unnamed')
      } satisfies CreateSessionForm
      const created = await client.createSession(createdAgent.id, session)
      dispatch(setActiveAgentId(createdAgent.id))
      dispatch(setActiveSessionIdAction({ agentId: createdAgent.id, sessionId: created.id }))
      window.navigate?.('/agents')
      setOpen(false)
    } catch (error) {
      logger.error('Failed to start first agent task', error as Error)
      window.toast.error(t('agent.session.create.error.failed'))
    } finally {
      setStartingTask(false)
    }
  }, [client, createdAgent, dispatch, startingTask, t])

  AgentModalPopup.hide = onCancel

  const stepCopy = {
    identity: {
      title: t('agent.createWizard.identity.title', 'Name this agent'),
      description: t(
        'agent.createWizard.identity.description',
        'Start with a clear identity. This name is how you will recognize and call this agent later.'
      )
    },
    instructions: {
      title: t('agent.createWizard.instructions.title', 'Shape its role'),
      description: t(
        'agent.createWizard.instructions.description',
        'These instructions become the agent system prompt and soul.md foundation. Keep them short, specific, and task-oriented.'
      )
    },
    model: {
      title: t('agent.createWizard.model.title', 'Choose a model'),
      description: t(
        'agent.createWizard.model.description',
        'The model decides how strong, fast, and costly this agent feels. You can change it later.'
      )
    },
    capabilities: {
      title: t('agent.createWizard.capabilities.title', 'Choose what it can use'),
      description: t(
        'agent.createWizard.capabilities.description',
        'Cherry Studio Pi starts with Soul Mode and built-in skills. Add workspace folders now, and tune advanced execution rules only when needed.'
      )
    }
  } satisfies Record<WizardStep, { title: string; description: string }>

  const renderStepContent = () => {
    switch (currentStep) {
      case 'identity':
        return (
          <>
            <FormItem>
              <Label>
                {t('common.name')} <RequiredMark>*</RequiredMark>
              </Label>
              <Input
                value={form.name}
                onChange={onNameChange}
                required
                autoFocus
                placeholder={t('agent.createWizard.identity.placeholder', 'e.g. Research Partner')}
              />
              <HelpText>
                {t(
                  'agent.createWizard.identity.helper',
                  'A concrete name makes the agent easier to trust, find, and reuse.'
                )}
              </HelpText>
            </FormItem>
          </>
        )
      case 'instructions':
        return (
          <FormItem>
            <Label>{t('agent.createWizard.instructions.label', 'System prompt / soul.md')}</Label>
            <TextArea rows={12} value={form.instructions ?? ''} onChange={onInstChange} />
            <HelpText>
              {t(
                'agent.createWizard.instructions.helper',
                'Describe the agent role, how it should work, and any boundaries it should respect.'
              )}
            </HelpText>
          </FormItem>
        )
      case 'model':
        return (
          <>
            <FormItem>
              <div className="flex items-center gap-2">
                <Label>
                  {t('common.model')} <RequiredMark>*</RequiredMark>
                </Label>
                <AnthropicProviderListPopover
                  useWindowNavigate
                  filterProviders={getAnthropicSupportedProviders}
                  onProviderClick={() => {
                    setOpen(false)
                    resolve(undefined)
                  }}
                />
              </div>
              <SelectAgentBaseModelButton
                agentBase={tempAgentBase}
                onSelect={handleModelSelect}
                fontSize={14}
                avatarSize={24}
                iconSize={16}
                buttonStyle={{
                  padding: '3px 8px',
                  width: '100%',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  height: 'auto'
                }}
                containerClassName="flex items-center justify-between w-full"
              />
              <HelpText>
                {t(
                  'agent.createWizard.model.helper',
                  'Pick the model you would trust with the agent core work. Stronger models usually work better for long tasks.'
                )}
              </HelpText>
            </FormItem>

            {isWin && (
              <FormItem>
                <div className="flex items-center gap-2">
                  <Label>
                    Git Bash <RequiredMark>*</RequiredMark>
                  </Label>
                  <HelpTooltip
                    title={t(
                      'agent.gitBash.tooltip',
                      'Git Bash is required to run agents on Windows. Install from git-scm.com if not available.'
                    )}
                  />
                </div>
                <GitBashInputWrapper>
                  <Input
                    value={gitBashPathInfo.path ?? ''}
                    readOnly
                    placeholder={t('agent.gitBash.placeholder', 'Select bash.exe path')}
                  />
                  <Button size="small" onClick={handlePickGitBash}>
                    {t('common.select', 'Select')}
                  </Button>
                  {gitBashPathInfo.source === 'manual' && (
                    <Button size="small" onClick={handleResetGitBash}>
                      {t('common.reset', 'Reset')}
                    </Button>
                  )}
                </GitBashInputWrapper>
                {gitBashPathInfo.path && gitBashPathInfo.source === 'auto' && (
                  <SourceHint>{t('agent.gitBash.autoDiscoveredHint', 'Auto-discovered')}</SourceHint>
                )}
              </FormItem>
            )}
          </>
        )
      case 'capabilities':
        return (
          <>
            <CapabilityCard>
              <div>
                <Label>{t('agent.settings.soulMode.title')}</Label>
                <HelpText>
                  {t(
                    'agent.createWizard.soulMode.helper',
                    'Enabled by default. The agent gets a persistent workspace and a soul.md-style identity foundation.'
                  )}
                </HelpText>
              </div>
              <Switch checked={soulEnabled} size="small" onChange={onSoulModeChange} />
            </CapabilityCard>

            <FormItem>
              <LabelWithButton>
                <Label>{t('agent.session.accessible_paths.label')}</Label>
                <Button size="small" onClick={addAccessiblePath}>
                  {t('agent.session.accessible_paths.add')}
                </Button>
              </LabelWithButton>
              {form.accessible_paths.length > 0 ? (
                <PathList>
                  {form.accessible_paths.map((path) => (
                    <PathItem key={path}>
                      <PathText title={path}>{path}</PathText>
                      <Button size="small" danger onClick={() => removeAccessiblePath(path)}>
                        {t('common.delete')}
                      </Button>
                    </PathItem>
                  ))}
                </PathList>
              ) : (
                <HelpText>
                  {t(
                    'agent.session.accessible_paths.default_hint',
                    'A default workspace will be created automatically if not specified.'
                  )}
                </HelpText>
              )}
            </FormItem>

            <AdvancedBox>
              <summary>{t('agent.createWizard.advanced.title', 'Advanced settings')}</summary>
              <AdvancedContent>
                <FormItem>
                  <Label>{t('agent.settings.tooling.permissionMode.title', 'Permission mode')}</Label>
                  <Select
                    value={selectedPermissionMode}
                    onChange={onPermissionModeChange}
                    style={{ width: '100%' }}
                    placeholder={t('agent.settings.tooling.permissionMode.placeholder', 'Select permission mode')}
                    optionLabelProp="label">
                    {permissionModeCards.map((item) => (
                      <Select.Option key={item.mode} value={item.mode} label={t(item.titleKey, item.titleFallback)}>
                        <PermissionOptionWrapper>
                          <div className="title">{t(item.titleKey, item.titleFallback)}</div>
                          <div className="description">{t(item.descriptionKey, item.descriptionFallback)}</div>
                        </PermissionOptionWrapper>
                      </Select.Option>
                    ))}
                  </Select>
                  <HelpText>
                    {t('agent.settings.tooling.permissionMode.helper', 'Choose how the agent handles tool approvals.')}
                  </HelpText>
                </FormItem>

                <FormItem>
                  <Label>{t('agent.settings.advance.envVars.label')}</Label>
                  <TextArea
                    rows={3}
                    value={envVarsText}
                    onChange={onEnvVarsChange}
                    placeholder={'API_KEY=xxx\nDEBUG=true'}
                  />
                  <HelpText>{t('agent.settings.advance.envVars.helper')}</HelpText>
                </FormItem>
              </AdvancedContent>
            </AdvancedBox>
          </>
        )
    }
  }

  return (
    <ErrorBoundary>
      <Modal
        title={createdAgent ? null : isEditing(agent) ? t('agent.edit.title') : t('agent.add.title')}
        open={open}
        onCancel={onCancel}
        afterClose={onClose}
        transitionName="animation-move-down"
        centered
        width={720}
        footer={null}>
        {createdAgent ? (
          <DonePanel>
            <SuccessIcon>
              <CheckCircle2 size={34} />
            </SuccessIcon>
            <DoneTitle>{t('agent.createWizard.done.title', 'Agent is ready')}</DoneTitle>
            <DoneSubtitle>
              {t(
                'agent.createWizard.done.description',
                '{{name}} has a model, a role, and a workspace. Give it the first task now.',
                { name: createdAgent.name }
              )}
            </DoneSubtitle>
            <AgentBadge>
              <Sparkles size={16} />
              <span>{createdAgent.name}</span>
            </AgentBadge>
            <Button type="primary" size="large" loading={startingTask} onClick={startTask}>
              {t('agent.createWizard.done.startTask', 'Start first task')}
            </Button>
          </DonePanel>
        ) : (
          <StyledForm onSubmit={onSubmit}>
            <WizardShell>
              <StepRail>
                {CREATE_STEPS.map((step, index) => (
                  <StepItem key={step} $active={step === currentStep} $done={index < stepIndex}>
                    <StepNumber>{index + 1}</StepNumber>
                    <span>{stepCopy[step].title}</span>
                  </StepItem>
                ))}
              </StepRail>

              <WizardMain>
                <StepHeader>
                  <StepEyebrow>
                    {t('agent.createWizard.stepCounter', 'Step {{current}} of {{total}}', {
                      current: stepIndex + 1,
                      total: CREATE_STEPS.length
                    })}
                  </StepEyebrow>
                  <StepTitle>{stepCopy[currentStep].title}</StepTitle>
                  <StepDescription>{stepCopy[currentStep].description}</StepDescription>
                </StepHeader>

                <FormContent>{renderStepContent()}</FormContent>

                <FormFooter>
                  <Button onClick={onCancel}>{t('common.close')}</Button>
                  {stepIndex > 0 && (
                    <Button icon={<ChevronLeft size={15} />} onClick={onBack}>
                      {t('common.back', 'Back')}
                    </Button>
                  )}
                  <Button type="primary" htmlType="submit" disabled={!canGoNext}>
                    {isLastStep ? (isCreating ? t('common.add') : t('common.confirm')) : t('common.next', 'Next')}
                  </Button>
                </FormFooter>
              </WizardMain>
            </WizardShell>
          </StyledForm>
        )}
      </Modal>
    </ErrorBoundary>
  )
}

const TopViewKey = 'AgentModalPopup'

export default class AgentModalPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}

// Keep the old export for backward compatibility during migration
export const AgentModal = AgentModalPopup

const StyledForm = styled.form`
  display: flex;
  flex-direction: column;
  min-height: 520px;
`

const FormContent = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 340px;
  padding-right: 8px;
`

const WizardShell = styled.div`
  display: flex;
  min-height: 520px;
`

const StepRail = styled.div`
  display: flex;
  flex: 0 0 210px;
  flex-direction: column;
  gap: 8px;
  padding: 8px 18px 8px 0;
  border-right: 1px solid var(--color-border);
`

const StepItem = styled.div<{ $active: boolean; $done: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 8px 10px;
  border-radius: 8px;
  color: ${({ $active, $done }) =>
    $active ? 'var(--color-primary)' : $done ? 'var(--color-text-1)' : 'var(--color-text-3)'};
  background: ${({ $active }) => ($active ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)' : 'transparent')};
  font-size: 13px;
  font-weight: ${({ $active }) => ($active ? 600 : 500)};
`

const StepNumber = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 13%, transparent);
  font-size: 12px;
`

const WizardMain = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  padding-left: 22px;
`

const StepHeader = styled.div`
  padding: 4px 0 18px;
`

const StepEyebrow = styled.div`
  color: var(--color-text-3);
  font-size: 12px;
`

const StepTitle = styled.div`
  margin-top: 6px;
  color: var(--color-text-1);
  font-size: 20px;
  font-weight: 650;
`

const StepDescription = styled.div`
  margin-top: 8px;
  max-width: 460px;
  color: var(--color-text-2);
  font-size: 13px;
  line-height: 1.5;
`

const FormItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const GitBashInputWrapper = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;

  input {
    flex: 1;
  }
`

const SourceHint = styled.span`
  font-size: 12px;
  color: var(--color-text-3);
`

const Label = styled.label`
  font-size: 14px;
  color: var(--color-text-1);
  font-weight: 500;
`

const RequiredMark = styled.span`
  color: #ff4d4f;
  margin-left: 4px;
`

const HelpText = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
`

const LabelWithButton = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`

const CapabilityCard = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-1);
`

const AdvancedBox = styled.details`
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-1);

  summary {
    cursor: pointer;
    padding: 12px;
    color: var(--color-text-1);
    font-size: 13px;
    font-weight: 600;
  }
`

const AdvancedContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 12px 12px;
`

const PathList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const PathItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-bg-1);
`

const PathText = styled.span`
  flex: 1;
  font-size: 13px;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const FormFooter = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 18px;
`

const DonePanel = styled.div`
  display: flex;
  min-height: 360px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  text-align: center;
`

const SuccessIcon = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 999px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  animation: agentDonePop 360ms cubic-bezier(0.2, 0.8, 0.2, 1);

  @keyframes agentDonePop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.86);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
`

const DoneTitle = styled.div`
  color: var(--color-text-1);
  font-size: 22px;
  font-weight: 700;
`

const DoneSubtitle = styled.div`
  max-width: 420px;
  color: var(--color-text-2);
  font-size: 14px;
  line-height: 1.5;
`

const AgentBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-1);
  background: var(--color-bg-1);
  font-size: 13px;
`

const PermissionOptionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;

  .title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-1);
    margin-bottom: 2px;
  }

  .description {
    font-size: 12px;
    color: var(--color-text-2);
    line-height: 1.4;
  }

  .behavior {
    font-size: 12px;
    color: var(--color-text-3);
    line-height: 1.4;
  }

  .caution {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    color: #ff4d4f;
    margin-top: 4px;
    padding: 6px 8px;
    background-color: rgba(255, 77, 79, 0.1);
    border-radius: 4px;

    svg {
      flex-shrink: 0;
      margin-top: 2px;
    }
  }
`
