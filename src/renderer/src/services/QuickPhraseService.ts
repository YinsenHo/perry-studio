import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { QuickPhrase } from '@renderer/types'
import { v4 as uuidv4 } from 'uuid'

import { storageV2DexieTableMirrorService } from './StorageV2DexieTableMirrorService'
import { storageV2DexieTableRecoveryService } from './StorageV2DexieTableRecoveryService'

const logger = loggerService.withContext('QuickPhraseService')

function sortQuickPhrases(phrases: QuickPhrase[]) {
  return phrases.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
}

export class QuickPhraseService {
  private static _isInitialized: boolean = false

  static async init() {
    if (QuickPhraseService._isInitialized) {
      return
    }

    try {
      await db.open()
      QuickPhraseService._isInitialized = true
    } catch (error) {
      logger.error('Failed to open Dexie database:', error as Error)
    }
  }

  static async getAll(): Promise<QuickPhrase[]> {
    // Ensure database is initialized before
    await QuickPhraseService.init()
    let phrases = await db.quick_phrases.toArray()
    if (phrases.length === 0) {
      const restored = await storageV2DexieTableRecoveryService.projectTableIfEmpty(
        'quick_phrases',
        'quick-phrases-empty'
      )
      if (restored) {
        phrases = await db.quick_phrases.toArray()
      }
    }
    return sortQuickPhrases(phrases)
  }

  static async add(data: Pick<QuickPhrase, 'title' | 'content'>): Promise<QuickPhrase> {
    const now = Date.now()
    const phrases = await this.getAll()

    await Promise.all(
      phrases.map((phrase) =>
        db.quick_phrases.update(phrase.id, {
          order: (phrase.order ?? 0) + 1
        })
      )
    )

    const phrase: QuickPhrase = {
      id: uuidv4(),
      title: data.title,
      content: data.content,
      createdAt: now,
      updatedAt: now,
      order: 0
    }

    await db.quick_phrases.add(phrase)
    for (const existingPhrase of phrases) {
      storageV2DexieTableMirrorService.scheduleRow('quick_phrases', existingPhrase.id, 0)
    }
    storageV2DexieTableMirrorService.scheduleRow('quick_phrases', phrase.id, 0)
    await storageV2DexieTableMirrorService.flush()
    return phrase
  }

  static async update(id: string, data: Pick<QuickPhrase, 'title' | 'content'>): Promise<void> {
    await QuickPhraseService.init()
    await db.quick_phrases.update(id, {
      ...data,
      updatedAt: Date.now()
    })
    storageV2DexieTableMirrorService.scheduleRow('quick_phrases', id, 0)
    await storageV2DexieTableMirrorService.flush()
  }

  static async delete(id: string): Promise<void> {
    await db.quick_phrases.delete(id)
    storageV2DexieTableMirrorService.scheduleDelete('quick_phrases', id)
    const phrases = sortQuickPhrases(await db.quick_phrases.toArray())
    await Promise.all(
      phrases.map((phrase, index) =>
        db.quick_phrases.update(phrase.id, {
          order: phrases.length - 1 - index
        })
      )
    )
    await storageV2DexieTableMirrorService.flush()
  }

  static async updateOrder(phrases: QuickPhrase[]): Promise<void> {
    const now = Date.now()
    await QuickPhraseService.init()
    await Promise.all(
      phrases.map((phrase, index) =>
        db.quick_phrases.update(phrase.id, {
          order: phrases.length - 1 - index,
          updatedAt: now
        })
      )
    )
    for (const phrase of phrases) {
      storageV2DexieTableMirrorService.scheduleRow('quick_phrases', phrase.id, 0)
    }
    await storageV2DexieTableMirrorService.flush()
  }
}

export default QuickPhraseService
