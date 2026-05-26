import type { Tool } from '@types'

// Pi-backed agent runtime builtin tools. The file name stays for persisted agent-type compatibility.
export const builtinTools: Tool[] = [
  {
    id: 'Bash',
    name: 'Bash',
    description: 'Executes shell commands in your environment',
    requirePermissions: true,
    type: 'builtin'
  },
  {
    id: 'Edit',
    name: 'Edit',
    description: 'Makes targeted edits to specific files',
    requirePermissions: true,
    type: 'builtin'
  },
  {
    id: 'Glob',
    name: 'Glob',
    description: 'Finds files based on pattern matching',
    requirePermissions: false,
    type: 'builtin'
  },
  {
    id: 'Grep',
    name: 'Grep',
    description: 'Searches for patterns in file contents',
    requirePermissions: false,
    type: 'builtin'
  },
  { id: 'Read', name: 'Read', description: 'Reads the contents of files', requirePermissions: false, type: 'builtin' },
  { id: 'Write', name: 'Write', description: 'Creates or overwrites files', requirePermissions: true, type: 'builtin' }
]
