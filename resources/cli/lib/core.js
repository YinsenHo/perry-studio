const DEFAULT_BASES = Array.from({ length: 10 }, (_, index) => `http://127.0.0.1:${23333 + index}`)

function parseArgs(argv) {
  const opts = {}
  const args = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      args.push(arg)
      continue
    }
    const [key, inlineValue] = arg.slice(2).split('=')
    const value = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
    opts[key] = value
  }
  return { command: args.shift() || 'help', args, opts }
}

function parseValue(raw) {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function discoverBase(opts = {}) {
  const preferred = opts['api-base'] || process.env.PERRY_STUDIO_API_BASE || process.env.CHERRY_STUDIO_API_BASE
  const bases = [...new Set([preferred, ...DEFAULT_BASES].filter(Boolean))]
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) })
      if (response.ok) return base
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Cherry Studio Pi API server is not reachable. Open Cherry Studio Pi or enable the API server.')
}

async function api(path, { method = 'GET', body, opts = {} } = {}) {
  const apiKey = opts['api-key'] || process.env.PERRY_STUDIO_API_KEY || process.env.CHERRY_STUDIO_API_KEY
  if (!apiKey) throw new Error('Missing API key. Set PERRY_STUDIO_API_KEY or pass --api-key.')

  const base = await discoverBase(opts)
  const response = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(data?.error || response.statusText)
  return data
}

function print(data, opts, human) {
  if (opts.json || !human) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  console.log(human(data))
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

module.exports = { api, fail, parseArgs, parseValue, print }
