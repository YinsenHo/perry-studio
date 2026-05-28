import * as fs from 'node:fs'

import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDefaultDataPath: vi.fn(),
  fs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn()
  }
}))

vi.mock('node:fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('../../../utils', () => ({
  getDefaultDataPath: mocks.getDefaultDataPath
}))

const manifest = {
  format: 'cherry-studio-pi-storage',
  version: 2,
  profileId: 'default',
  workspaceId: 'workspace-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastOpenedBy: {
    appId: 'com.cherryai.cherrystudio-pi',
    productName: 'Cherry Studio Pi',
    version: '1.0.0'
  }
}

describe('StorageV2DataRootService', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.CHERRY_STUDIO_STORAGE_V2_ROOT
    mocks.getDefaultDataPath.mockReturnValue('/mock/appData/Cherry Studio Pi/Data')
    vi.mocked(app.getPath).mockImplementation((key: string) => {
      if (key === 'appData') return '/mock/appData'
      if (key === 'home') return '/mock/home'
      if (key === 'userData') return '/mock/appData/Cherry Studio Pi'
      return '/mock/unknown'
    })
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(manifest))
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as never)
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 1
    } as never)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined as never)
    vi.mocked(fs.renameSync).mockReturnValue(undefined as never)
  })

  it('prefers a legacy user data root with real data when the renamed current root is empty', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => String(candidate) === '/mock/appData/Perry Studio/Data/agents.db'
    )

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/appData/Perry Studio/Data')
    expect(info.source).toBe('legacy-user-data')
  })

  it('keeps the current root when it already has legacy data', async () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      ['/mock/appData/Cherry Studio Pi/Data/app.db', '/mock/appData/Perry Studio/Data/agents.db'].includes(
        String(candidate)
      )
    )

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/appData/Cherry Studio Pi/Data')
    expect(info.source).toBe('current-user-data')
  })

  it('treats a Storage v2 main database as existing data even when the manifest is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => String(candidate) === '/mock/appData/Perry Studio/Data/main.db'
    )

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/appData/Perry Studio/Data')
    expect(info.source).toBe('legacy-user-data')
  })

  it('prefers an existing Storage v2 manifest over legacy data candidates', async () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      ['/mock/appData/Cherry Studio Pi/Data/manifest.json', '/mock/appData/Perry Studio/Data/agents.db'].includes(
        String(candidate)
      )
    )

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/appData/Cherry Studio Pi/Data')
    expect(info.manifest?.workspaceId).toBe('workspace-1')
  })

  it('uses an active configured data root before creating an empty current root', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, '/mock/configured-root'].includes(String(candidate))
    )
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'cherry-studio-pi',
              profileId: 'default',
              path: '/mock/configured-root',
              active: true
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/configured-root')
    expect(info.source).toBe('config')
  })

  it('accepts active configured roots written by legacy Perry Studio builds', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, '/mock/perry-custom-root', '/mock/perry-custom-root/main.db'].includes(String(candidate))
    )
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'perry-studio',
              profileId: 'default',
              path: '/mock/perry-custom-root',
              active: true
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/perry-custom-root')
    expect(info.source).toBe('config')
  })

  it('does not let an empty configured root shadow real data in the current root', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    const currentRoot = '/mock/appData/Cherry Studio Pi/Data'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, '/mock/configured-root', `${currentRoot}/agents.db`].includes(String(candidate))
    )
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'cherry-studio-pi',
              profileId: 'default',
              path: '/mock/configured-root',
              active: true
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe(currentRoot)
    expect(info.source).toBe('current-user-data')
  })

  it('does not count empty data directories as real runtime data', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    const configuredRoot = '/mock/stale-root'
    const currentRoot = '/mock/appData/Cherry Studio Pi/Data'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, configuredRoot, `${configuredRoot}/Files`, `${currentRoot}/app.db`].includes(String(candidate))
    )
    vi.mocked(fs.statSync).mockImplementation(
      (candidate) =>
        ({
          isDirectory: () => String(candidate).endsWith('/Files'),
          isFile: () => !String(candidate).endsWith('/Files'),
          size: 1
        }) as never
    )
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'cherry-studio-pi',
              profileId: 'default',
              path: configuredRoot,
              active: true
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe(currentRoot)
    expect(info.source).toBe('current-user-data')
  })

  it('registers a restored current data root as active', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    const restoredRoot = '/mock/appData/Cherry Studio Pi/Data'
    const configuredRoot = '/mock/configured-root'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, restoredRoot, `${restoredRoot}/manifest.json`, configuredRoot].includes(String(candidate))
    )
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'perry-studio',
              profileId: 'default',
              path: configuredRoot,
              active: true,
              createdAt: '2025-01-01T00:00:00.000Z'
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const activated = new StorageV2DataRootService().activateDataRoot(restoredRoot)

    expect(activated?.workspaceId).toBe('workspace-1')

    const configWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) => String(call[1]))
      .find((content) => content.includes('"dataRoots"'))
    const nextConfig = JSON.parse(configWrite!)

    expect(nextConfig.dataRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: configuredRoot,
          active: false
        }),
        expect.objectContaining({
          path: restoredRoot,
          active: true
        })
      ])
    )
  })

  it('registers the selected app data path Data directory as active', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    const previousRoot = '/mock/appData/Perry Studio/Data'
    const selectedRoot = '/mock/selected-user-data/Data'
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      [configPath, previousRoot, selectedRoot, `${selectedRoot}/manifest.json`].includes(String(candidate))
    )
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'perry-studio',
              profileId: 'default',
              path: previousRoot,
              active: true,
              createdAt: '2025-01-01T00:00:00.000Z'
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const activated = new StorageV2DataRootService().activateAppDataRoot('/mock/selected-user-data')

    expect(activated.workspaceId).toBe('workspace-1')
    expect(fs.mkdirSync).toHaveBeenCalledWith(selectedRoot, { recursive: true })

    const configWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) => String(call[1]))
      .find((content) => content.includes('"dataRoots"'))
    const nextConfig = JSON.parse(configWrite!)

    expect(nextConfig.dataRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: previousRoot,
          active: false
        }),
        expect.objectContaining({
          path: selectedRoot,
          active: true
        })
      ])
    )
  })

  it('creates a fresh active data root when the selected app data path has no Data manifest', async () => {
    const configPath = '/mock/home/.cherrystudio/config/config.json'
    const previousRoot = '/mock/appData/Perry Studio/Data'
    const selectedRoot = '/mock/fresh-user-data/Data'
    vi.mocked(fs.existsSync).mockImplementation((candidate) => [configPath, previousRoot].includes(String(candidate)))
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) === configPath) {
        return JSON.stringify({
          dataRoots: [
            {
              app: 'perry-studio',
              profileId: 'default',
              path: previousRoot,
              active: true,
              createdAt: '2025-01-01T00:00:00.000Z'
            }
          ]
        })
      }

      return JSON.stringify(manifest)
    })

    const { StorageV2DataRootService } = await import('../DataRootService')
    const activated = new StorageV2DataRootService().activateAppDataRoot('/mock/fresh-user-data')

    expect(activated.format).toBe('cherry-studio-pi-storage')
    expect(activated.workspaceId).toBeTruthy()
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`${selectedRoot}/manifest.json.`),
      expect.stringContaining('"format": "cherry-studio-pi-storage"')
    )

    const configWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) => String(call[1]))
      .find((content) => content.includes('"dataRoots"'))
    const nextConfig = JSON.parse(configWrite!)

    expect(nextConfig.dataRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: previousRoot,
          active: false
        }),
        expect.objectContaining({
          path: selectedRoot,
          active: true
        })
      ])
    )
  })

  it('creates a fresh manifest for a staged reset data root without registering it early', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { StorageV2DataRootService } = await import('../DataRootService')
    const nextManifest = new StorageV2DataRootService().createFreshDataRootManifest(
      '/mock/appData/Cherry Studio Pi/Data.restore'
    )

    expect(nextManifest.format).toBe('cherry-studio-pi-storage')
    expect(nextManifest.workspaceId).toBeTruthy()
    expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/appData/Cherry Studio Pi/Data.restore', { recursive: true })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/mock/appData/Cherry Studio Pi/Data.restore/manifest.json.'),
      expect.stringContaining('"format": "cherry-studio-pi-storage"')
    )

    const configWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) => String(call[1]))
      .find((content) => content.includes('"dataRoots"'))
    expect(configWrite).toBeUndefined()
  })

  it('lets the explicit env root override discovered manifests', async () => {
    process.env.CHERRY_STUDIO_STORAGE_V2_ROOT = '/mock/env-root'
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => String(candidate) === '/mock/appData/Cherry Studio Pi/Data/manifest.json'
    )

    const { StorageV2DataRootService } = await import('../DataRootService')
    const info = new StorageV2DataRootService().resolveDataRoot()

    expect(info.dataRoot).toBe('/mock/env-root')
    expect(info.source).toBe('env')
  })
})
