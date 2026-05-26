import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAppSelector } from '@renderer/store'
import type { ToolPermissionEntry } from '@renderer/store/toolPermissions'
import type { MCPToolResponseStatus } from '@renderer/types'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { isToolPending } from '@renderer/utils/userConfirmation'
import { Collapse, type CollapseProps } from 'antd'
import { CheckCircle2, ChevronRight, LoaderCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useToolApproval } from '../Tools/hooks/useToolApproval'
import { getEffectiveStatus, type ToolStatus, ToolStatusIndicator } from '../Tools/MessageAgentTools/GenericTools'
import MessageTools from '../Tools/MessageTools'
import ToolApprovalActionsComponent from '../Tools/ToolApprovalActions'
import ToolHeader from '../Tools/ToolHeader'
import BlockErrorFallback from './BlockErrorFallback'
import { getToolActivitySummary } from './toolActivitySummary'

// ============ Styled Components ============

const Container = styled.div`
  width: fit-content;
  max-width: 100%;

  /* Only style the direct group collapse, not nested tool collapses */
  > .ant-collapse {
    background: transparent;
    border: none;

    > .ant-collapse-item {
      border: none !important;

      > .ant-collapse-header {
        padding: 7px 11px !important;
        background: var(--color-background);
        border: 1px solid var(--color-border);
        border-radius: 8px !important;
        display: flex;
        align-items: center;
        transition:
          background 0.2s ease,
          border-color 0.2s ease;

        &:hover {
          background: var(--color-background-soft);
          border-color: var(--color-border-soft);
        }

        .ant-collapse-expand-icon {
          padding: 0 !important;
          margin-left: 8px;
          height: auto !important;
        }
      }

      > .ant-collapse-content {
        border: none;
        background: transparent;

        > .ant-collapse-content-box {
          padding: 4px 0 0 0 !important;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
      }
    }
  }
`

const GroupHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 400;
  min-width: 0;
`

const ActivityHeader = styled(GroupHeader)`
  .tool-activity {
    color: var(--color-text-2);
    white-space: nowrap;
  }

  .tool-spinner {
    color: var(--color-text-3);
    animation: tool-spin 1.1s linear infinite;
  }

  .tool-done {
    color: var(--color-text-3);
  }

  .tool-summary {
    min-width: 0;
    max-width: min(460px, 62vw);
    color: var(--color-text);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes tool-spin {
    to {
      transform: rotate(360deg);
    }
  }
`

const ActivityDots = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;

  span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--color-text-3);
    opacity: 0.35;
    animation: activity-dot 1.2s ease-in-out infinite;
  }

  span:nth-child(2) {
    animation-delay: 0.15s;
  }

  span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes activity-dot {
    0%,
    80%,
    100% {
      opacity: 0.25;
      transform: translateY(0);
    }

    40% {
      opacity: 0.7;
      transform: translateY(-1px);
    }
  }
`

const ScrollableToolList = styled.div`
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const ToolItem = styled.div<{ $isCompleted: boolean }>`
  opacity: ${(props) => (props.$isCompleted ? 0.82 : 1)};
  transition: opacity 0.2s;
`

const CompactToolShell = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  overflow: hidden;
`

const CompactToolRow = styled.button`
  width: 100%;
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  text-align: left;
  cursor: pointer;
  color: inherit;

  &:hover {
    background: var(--color-background-soft);
  }
`

const CompactToolIcon = styled(ChevronRight)<{ $expanded: boolean }>`
  flex-shrink: 0;
  color: var(--color-text-3);
  transform: ${({ $expanded }) => ($expanded ? 'rotate(90deg)' : 'rotate(0deg)')};
  transition: transform 0.16s ease;
`

const CompactTaskSummary = styled.div`
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  min-width: 0;
`

const CompactTaskTitle = styled.span`
  color: var(--color-text);
  font-size: 13px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const CompactToolDetails = styled.div`
  border-top: 1px solid var(--color-border);
  padding: 4px;

  .ant-collapse {
    max-width: 100%;
  }

  .ant-collapse-content-box {
    max-height: 220px !important;
    overflow: auto !important;
  }
`

const AnimatedHeaderWrapper = styled(motion.div)`
  display: inline-block;
`

const HeaderWithActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: space-between;
`

// ============ Types & Helpers ============

interface Props {
  blocks: ToolMessageBlock[]
}

function isCompletedStatus(status: MCPToolResponseStatus | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

// Calculate actual waiting state for a block (not depending on hooks)
function getBlockIsWaiting(block: ToolMessageBlock, agentPermissions: Record<string, ToolPermissionEntry>): boolean {
  const toolResponse = block.metadata?.rawMcpToolResponse
  if (!toolResponse || toolResponse.status !== 'pending') return false

  const tool = toolResponse.tool
  if (tool?.type === 'mcp') {
    // MCP tools: check the global confirmation queue
    return isToolPending(toolResponse.id)
  } else {
    // Agent tools: check Redux store for pending permission
    const permission = Object.values(agentPermissions).find((p) => p.toolCallId === toolResponse.toolCallId)
    return permission?.status === 'pending'
  }
}

// Get effective UI status for a block
function getBlockEffectiveStatus(
  block: ToolMessageBlock,
  agentPermissions: Record<string, ToolPermissionEntry>
): ToolStatus {
  const toolResponse = block.metadata?.rawMcpToolResponse
  const isWaiting = getBlockIsWaiting(block, agentPermissions)
  return getEffectiveStatus(toolResponse?.status, isWaiting)
}

function getLastActiveBlock(
  blocks: ToolMessageBlock[],
  agentPermissions: Record<string, ToolPermissionEntry>
): ToolMessageBlock | undefined {
  return [...blocks].reverse().find((block) => {
    const status = getBlockEffectiveStatus(block, agentPermissions)
    return status === 'invoking' || status === 'streaming'
  })
}

function getLastSummaryBlock(
  blocks: ToolMessageBlock[],
  agentPermissions: Record<string, ToolPermissionEntry>
): ToolMessageBlock | undefined {
  return getLastActiveBlock(blocks, agentPermissions) ?? blocks.at(-1)
}

// Animation variants for smooth header transitions
const headerVariants = {
  enter: { x: 20, opacity: 0 },
  center: { x: 0, opacity: 1, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { x: -20, opacity: 0, transition: { duration: 0.15 } }
}

// ============ Sub-Components ============

const AnimatedHeader = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <AnimatePresence mode="wait">
    <AnimatedHeaderWrapper key={id} variants={headerVariants} initial="enter" animate="center" exit="exit">
      {children}
    </AnimatedHeaderWrapper>
  </AnimatePresence>
)

// Component for rendering a block with approval actions
const WaitingToolHeader = React.memo(({ block }: { block: ToolMessageBlock }) => {
  const approval = useToolApproval(block)
  const toolResponse = block.metadata?.rawMcpToolResponse
  const effectiveStatus = getEffectiveStatus(toolResponse?.status, approval.isWaiting)

  return (
    <HeaderWithActions>
      <ToolHeader block={block} variant="collapse-label" status={effectiveStatus} />
      {(approval.isWaiting || approval.isExecuting) && <ToolApprovalActionsComponent {...approval} compact />}
    </HeaderWithActions>
  )
})
WaitingToolHeader.displayName = 'WaitingToolHeader'

interface GroupHeaderContentProps {
  blocks: ToolMessageBlock[]
  allCompleted: boolean
}

const GroupHeaderContent = React.memo(({ blocks, allCompleted }: GroupHeaderContentProps) => {
  const { t, i18n } = useTranslation()
  const agentPermissions = useAppSelector((state) => state.toolPermissions.requests)
  const summaryBlock = useMemo(() => getLastSummaryBlock(blocks, agentPermissions), [blocks, agentPermissions])
  const summaryText = useMemo(
    () => (summaryBlock ? getToolActivitySummary(summaryBlock, i18n.language) : undefined),
    [summaryBlock, i18n.language]
  )
  const waitingBlocks = blocks.filter((block) => getBlockEffectiveStatus(block, agentPermissions) === 'waiting')
  const hasActiveBlock = blocks.some((block) => {
    const status = getBlockEffectiveStatus(block, agentPermissions)
    return status === 'waiting' || status === 'invoking' || status === 'streaming'
  })

  if (allCompleted || !hasActiveBlock) {
    return (
      <ActivityHeader aria-live="polite">
        <CheckCircle2 size={14} className="tool-done" />
        {summaryText && <span className="tool-summary">{summaryText}</span>}
      </ActivityHeader>
    )
  }

  // Prioritize showing waiting blocks that need approval
  const lastWaitingBlock = waitingBlocks[waitingBlocks.length - 1]
  if (lastWaitingBlock) {
    return (
      <AnimatedHeader id={lastWaitingBlock.id}>
        <WaitingToolHeader block={lastWaitingBlock} />
      </AnimatedHeader>
    )
  }

  return (
    <AnimatedHeader id={summaryBlock?.id || 'tool-activity'}>
      <ActivityHeader aria-live="polite">
        <LoaderCircle size={14} className="tool-spinner" />
        <span className="tool-activity">{t('message.tools.activity.running')}</span>
        {summaryText && <span className="tool-summary">{summaryText}</span>}
        <ActivityDots aria-hidden="true">
          <span />
          <span />
          <span />
        </ActivityDots>
      </ActivityHeader>
    </AnimatedHeader>
  )
})
GroupHeaderContent.displayName = 'GroupHeaderContent'

// Component for tool list content with auto-scroll
interface ToolListContentProps {
  blocks: ToolMessageBlock[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}

const ToolListContent = React.memo(({ blocks, scrollRef }: ToolListContentProps) => (
  <ScrollableToolList ref={scrollRef}>
    {blocks.map((block) => (
      <CompactToolListItem key={block.id} block={block} />
    ))}
  </ScrollableToolList>
))
ToolListContent.displayName = 'ToolListContent'

const CompactToolListItem = React.memo(({ block }: { block: ToolMessageBlock }) => {
  const [expanded, setExpanded] = useState(false)
  const { i18n } = useTranslation()
  const agentPermissions = useAppSelector((state) => state.toolPermissions.requests)
  const status = block.metadata?.rawMcpToolResponse?.status
  const effectiveStatus = getBlockEffectiveStatus(block, agentPermissions)
  const isWaiting = effectiveStatus === 'waiting'
  const isCompleted = isCompletedStatus(status)
  const hasError = effectiveStatus === 'error' || block.metadata?.rawMcpToolResponse?.response?.isError === true
  const summaryText = useMemo(() => getToolActivitySummary(block, i18n.language), [block, i18n.language])

  if (isWaiting) {
    return (
      <ToolItem data-block-id={block.id} $isCompleted={false}>
        <ErrorBoundary fallbackComponent={BlockErrorFallback}>
          <MessageTools block={block} />
        </ErrorBoundary>
      </ToolItem>
    )
  }

  return (
    <ToolItem data-block-id={block.id} $isCompleted={isCompleted}>
      <CompactToolShell>
        <CompactToolRow type="button" onClick={() => setExpanded((value) => !value)}>
          <CompactToolIcon size={14} $expanded={expanded} />
          <CompactTaskSummary>
            <CompactTaskTitle>{summaryText}</CompactTaskTitle>
            <ToolStatusIndicator status={effectiveStatus} hasError={hasError} />
          </CompactTaskSummary>
        </CompactToolRow>
        {expanded && (
          <CompactToolDetails>
            <ErrorBoundary fallbackComponent={BlockErrorFallback}>
              <MessageTools block={block} />
            </ErrorBoundary>
          </CompactToolDetails>
        )}
      </CompactToolShell>
    </ToolItem>
  )
})
CompactToolListItem.displayName = 'CompactToolListItem'

// ============ Main Component ============

const ToolBlockGroup: React.FC<Props> = ({ blocks }) => {
  const [activeKey, setActiveKey] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const userExpandedRef = useRef(false)
  const autoExpandedForApprovalRef = useRef(false)
  const agentPermissions = useAppSelector((state) => state.toolPermissions.requests)

  const allCompleted = useMemo(() => {
    return blocks.every((block) => {
      const status = block.metadata?.rawMcpToolResponse?.status
      return isCompletedStatus(status)
    })
  }, [blocks])

  const hasWaitingApproval = useMemo(() => {
    return blocks.some((block) => getBlockEffectiveStatus(block, agentPermissions) === 'waiting')
  }, [blocks, agentPermissions])

  // Keep actionable approval requests visible; routine execution stays compact by default.
  useEffect(() => {
    if (hasWaitingApproval) {
      autoExpandedForApprovalRef.current = true
      setActiveKey((prev) => (prev.includes('tool-group') ? prev : [...prev, 'tool-group']))
      return
    }

    if (autoExpandedForApprovalRef.current && !userExpandedRef.current) {
      autoExpandedForApprovalRef.current = false
      setActiveKey([])
      return
    }

    if (allCompleted && !userExpandedRef.current) {
      setActiveKey([])
    }
  }, [allCompleted, hasWaitingApproval])

  const currentRunningBlock = useMemo(() => {
    return [...blocks].reverse().find((block) => {
      const status = block.metadata?.rawMcpToolResponse?.status
      return !isCompletedStatus(status)
    })
  }, [blocks])

  useEffect(() => {
    if (activeKey.includes('tool-group') && currentRunningBlock && scrollRef.current) {
      const element = scrollRef.current.querySelector(`[data-block-id="${currentRunningBlock.id}"]`)
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeKey, currentRunningBlock])

  const handleChange = (keys: string | string[]) => {
    const keyArray = Array.isArray(keys) ? keys : [keys]
    const isExpanding = keyArray.includes('tool-group')
    userExpandedRef.current = isExpanding
    if (!isExpanding) autoExpandedForApprovalRef.current = false
    setActiveKey(keyArray)
  }

  const items: CollapseProps['items'] = useMemo(() => {
    return [
      {
        key: 'tool-group',
        label: <GroupHeaderContent blocks={blocks} allCompleted={allCompleted} />,
        children: <ToolListContent blocks={blocks} scrollRef={scrollRef} />
      }
    ]
  }, [blocks, allCompleted])

  return (
    <Container>
      <Collapse
        ghost
        size="small"
        expandIconPosition="end"
        activeKey={activeKey}
        onChange={handleChange}
        items={items}
      />
    </Container>
  )
}

export default React.memo(ToolBlockGroup)
