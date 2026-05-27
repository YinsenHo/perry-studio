import { SettingOutlined } from '@ant-design/icons'
import { showErrorDetailPopup } from '@renderer/components/ErrorDetailModal'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useTimer } from '@renderer/hooks/useTimer'
import { getHttpMessageLabel, getProviderLabel } from '@renderer/i18n/label'
import type { DiagnosisResult } from '@renderer/services/ErrorDiagnosisService'
import { classifyErrorByAI } from '@renderer/services/ErrorDiagnosisService'
import { getProviderById } from '@renderer/services/ProviderService'
import { useAppDispatch } from '@renderer/store'
import { removeBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import type { ErrorMessageBlock, Message } from '@renderer/types/newMessage'
import { classifyError } from '@renderer/utils/errorClassifier'
import { Button } from 'antd'
import { AlertTriangle, ChevronRight, CirclePause, RotateCcw, X } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

const HTTP_ERROR_CODES = [400, 401, 403, 404, 429, 500, 502, 503, 504]

// Module-level cache for AI classification to avoid duplicate API calls
const aiClassifyCache = new Map<string, Promise<string>>()

interface Props {
  block: ErrorMessageBlock
  message: Message
  topic?: Topic
  assistant?: Assistant
}

const isStreamPausedBlock = (block: ErrorMessageBlock) => block.error?.i18nKey === ERROR_I18N_KEY_STREAM_PAUSED

const ErrorBlock: React.FC<Props> = ({ block, message, topic, assistant }) => {
  if (isStreamPausedBlock(block)) {
    return <MessagePausedInfo block={block} message={message} topic={topic} assistant={assistant} />
  }

  return <MessageErrorInfo block={block} message={message} />
}

const ErrorMessage: React.FC<{ block: ErrorMessageBlock }> = ({ block }) => {
  const { t, i18n } = useTranslation()

  const i18nKey = block.error && 'i18nKey' in block.error ? `error.${block.error?.i18nKey}` : ''
  const errorKey = `error.${block.error?.message}`
  const errorStatus =
    block.error && ('status' in block.error || 'statusCode' in block.error)
      ? block.error?.status || block.error?.statusCode
      : undefined

  if (i18n.exists(i18nKey)) {
    const providerId = block.error && 'providerId' in block.error ? block.error?.providerId : undefined
    if (providerId && typeof providerId === 'string') {
      return (
        <Trans
          i18nKey={i18nKey}
          values={{ provider: getProviderLabel(providerId) }}
          components={{
            provider: (
              <Link
                style={{ color: 'var(--color-link)' }}
                to={`/settings/provider`}
                state={{ provider: getProviderById(providerId) }}
              />
            )
          }}
        />
      )
    }
  }

  if (i18n.exists(errorKey)) {
    return t(errorKey)
  }

  if (typeof errorStatus === 'number' && HTTP_ERROR_CODES.includes(errorStatus)) {
    return (
      <span>
        {getHttpMessageLabel(errorStatus.toString())} {block.error?.message}
      </span>
    )
  }

  return block.error?.message || ''
}

const PausedResumeButton: React.FC<{ message: Message; topic: Topic; assistant: Assistant }> = ({
  message,
  topic,
  assistant
}) => {
  const { t } = useTranslation()
  const { regenerateAssistantMessage } = useMessageOperations(topic)

  const onResume = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void regenerateAssistantMessage(message, assistant)
    },
    [assistant, message, regenerateAssistantMessage]
  )

  return (
    <button
      type="button"
      className="hover:-translate-y-px inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-all duration-150"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-primary) 22%, transparent)',
        background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)',
        color: 'var(--color-primary)'
      }}
      onClick={onResume}>
      <RotateCcw size={13} />
      {t('error.stream_paused_resume')}
    </button>
  )
}

const MessagePausedInfo: React.FC<{
  block: ErrorMessageBlock
  message: Message
  topic?: Topic
  assistant?: Assistant
}> = ({ block, message, topic, assistant }) => {
  const dispatch = useAppDispatch()
  const { setTimeoutTimer } = useTimer()
  const { t } = useTranslation()

  const onRemoveBlock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setTimeoutTimer(
        'onRemovePausedBlock',
        () => dispatch(removeBlocksThunk(message.topicId, message.id, [block.id])),
        350
      )
    },
    [setTimeoutTimer, dispatch, message.topicId, message.id, block.id]
  )

  return (
    <div
      className="group relative my-2 rounded-lg border px-3.5 py-3 text-[13px] transition-all duration-200"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-primary) 18%, var(--color-border))',
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--color-primary) 5%, transparent), color-mix(in srgb, var(--color-background) 92%, transparent))'
      }}>
      <button
        type="button"
        className="absolute top-2 right-2 flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded border-none bg-transparent opacity-0 transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] hover:text-(--color-primary) group-hover:opacity-100"
        onClick={onRemoveBlock}
        aria-label="close"
        title={t('common.close')}>
        <X size={14} />
      </button>

      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex shrink-0 items-center justify-center" style={{ color: 'var(--color-primary)' }}>
          <CirclePause size={15} />
        </div>
        <div className="pr-5 text-[13px] leading-[1.4]" style={{ color: 'var(--color-text)' }}>
          {t('error.stream_paused_title')}
        </div>
      </div>

      <div className="ml-5.75 text-xs leading-normal" style={{ color: 'var(--color-text-2)' }}>
        {t('error.stream_paused_description')}
      </div>

      <div className="mt-2.5 ml-5.75 flex items-center">
        {topic && assistant && <PausedResumeButton message={message} topic={topic} assistant={assistant} />}
      </div>
    </div>
  )
}

const MessageErrorInfo: React.FC<{ block: ErrorMessageBlock; message: Message }> = ({ block, message }) => {
  const dispatch = useAppDispatch()
  const { setTimeoutTimer } = useTimer()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [aiSummary, setAiSummary] = useState<string>('')

  const providerId = message.model?.provider ?? (block.error?.providerId as string | undefined)
  const classification = useMemo(() => classifyError(block.error, providerId), [block.error, providerId])

  // AI fallback: when rule-based classification returns 'unknown', ask AI for a one-line summary
  const errorForAI = block.error
  useEffect(() => {
    if (classification.category !== 'unknown' || !errorForAI?.message) return
    let cancelled = false
    const cacheKey = `${errorForAI.message}:${i18n.language}`
    const cached = aiClassifyCache.get(cacheKey)
    const promise =
      cached ??
      classifyErrorByAI(errorForAI, i18n.language).then((summary) => {
        if (!summary) aiClassifyCache.delete(cacheKey)
        return summary
      })
    if (!cached) aiClassifyCache.set(cacheKey, promise)
    promise
      .then((summary) => {
        if (!cancelled && summary) setAiSummary(summary)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [classification.category, errorForAI, i18n.language])

  const diagnosisContext = useMemo(
    () => ({
      errorSource: 'chat' as const,
      providerName: block.error?.providerId as string | undefined,
      modelId: block.error?.modelId as string | undefined
    }),
    [block.error?.providerId, block.error?.modelId]
  )

  const onRemoveBlock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setTimeoutTimer('onRemoveBlock', () => dispatch(removeBlocksThunk(message.topicId, message.id, [block.id])), 350)
    },
    [setTimeoutTimer, dispatch, message.topicId, message.id, block.id]
  )

  const showErrorDetail = () => {
    showErrorDetailPopup({
      error: block.error,
      blockId: block.id,
      cachedDiagnosis: block.metadata?.diagnosis as DiagnosisResult | undefined,
      diagnosisContext
    })
  }

  const onNavigate = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (classification.navTarget) {
      navigate(classification.navTarget)
    }
  }

  return (
    <div
      className="group relative my-2 cursor-pointer rounded-lg border px-3.5 py-3 text-[13px] transition-all duration-200 hover:border-[color-mix(in_srgb,var(--color-error)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_7%,transparent)]"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-error) 20%, transparent)',
        background: 'color-mix(in srgb, var(--color-error) 4%, transparent)'
      }}
      onClick={showErrorDetail}>
      {/* Close button */}
      <button
        type="button"
        className="absolute top-2 right-2 flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded border-none bg-transparent opacity-0 transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] hover:text-(--color-error) group-hover:opacity-100"
        onClick={onRemoveBlock}
        aria-label="close"
        title={t('common.close')}>
        <X size={14} />
      </button>

      {/* Header: icon + title */}
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex shrink-0 items-center justify-center" style={{ color: 'var(--color-error)' }}>
          <AlertTriangle size={15} />
        </div>
        <div className="pr-5 font-semibold text-[13px] leading-[1.4]" style={{ color: 'var(--color-error)' }}>
          {aiSummary || t(classification.i18nKey)}
        </div>
      </div>

      {/* Description */}
      <div
        className="wrap-break-word ml-5.75 line-clamp-3 text-xs leading-normal [&_a]:text-(--color-link)"
        style={{ color: 'var(--color-text-2)' }}>
        {block.error?.message || <ErrorMessage block={block} />}
      </div>

      {/* Footer */}
      <div className="mt-2.5 ml-5.75 flex items-center gap-2">
        {classification.navTarget && (
          <Button
            size="small"
            type="default"
            className="inline-flex items-center gap-1 rounded-[5px] border-[color-mix(in_srgb,var(--color-error)_25%,transparent)] text-(--color-error) text-xs hover:border-(--color-error)"
            onClick={onNavigate}>
            <SettingOutlined style={{ fontSize: 12 }} />
            {t('error.diagnosis.go_to_settings')}
          </Button>
        )}
        <div
          className="ml-auto inline-flex items-center gap-0.5 text-xs transition-colors duration-150 group-hover:text-(--color-error)"
          style={{ color: 'var(--color-text-3)' }}>
          {t('common.detail')}
          <ChevronRight size={14} />
        </div>
      </div>
    </div>
  )
}

export default React.memo(ErrorBlock)
