import { loggerService } from '@logger'

import { storageV2MirrorService } from './StorageV2MirrorService'

const logger = loggerService.withContext('StorageV2ReduxMirrorFlush')

export async function flushStorageV2ReduxMirror(reason: string, options: { strict?: boolean } = {}) {
  try {
    if (options.strict) {
      await storageV2MirrorService.flushStrict()
    } else {
      await storageV2MirrorService.flush()
    }
  } catch (error) {
    logger.warn(`Failed to flush Storage v2 Redux mirror after ${reason}`, error as Error)
    if (options.strict) {
      throw error
    }
  }
}
