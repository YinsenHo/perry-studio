import fs from 'node:fs'
import path from 'node:path'

function isCrossDeviceError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')
}

export function getAvailablePathSync(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return targetPath

  const parsed = path.parse(targetPath)
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }

  return path.join(parsed.dir, `${parsed.name}.${Date.now()}${parsed.ext}`)
}

export function movePathSync(sourcePath: string, targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(`Refusing to overwrite existing path while moving ${sourcePath} to ${targetPath}`)
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  try {
    fs.renameSync(sourcePath, targetPath)
    return
  } catch (error) {
    if (!isCrossDeviceError(error)) {
      throw error
    }
  }

  const stats = fs.statSync(sourcePath)
  if (stats.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true })
    fs.rmSync(sourcePath, { recursive: true, force: true })
    return
  }

  fs.copyFileSync(sourcePath, targetPath)
  fs.unlinkSync(sourcePath)
}
