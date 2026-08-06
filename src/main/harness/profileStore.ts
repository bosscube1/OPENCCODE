/**
 * Global persistence for custom agent profiles.
 *
 * Follows the sync-read / async-write pattern from appSettings.ts:
 * - `readSync()` for fast startup reads (no async)
 * - `write()` for durable saves (async, best-effort)
 *
 * Built-in profiles are never persisted — they are merged at read time.
 * Custom profiles override built-ins by id.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_PROFILES, validateProfile, type AgentProfile } from './profiles'

const STORE_VERSION = 1

type ProfileStoreFile = {
  version: typeof STORE_VERSION
  profiles: AgentProfile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storePath(): string {
  return join(app.getPath('userData'), 'harness-profiles.json')
}

/** Read custom profiles from disk. A missing or corrupt file reads as empty and never throws. */
function readCustomSync(): AgentProfile[] {
  try {
    const path = storePath()
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return []
    if (!Array.isArray(parsed.profiles)) return []
    return parsed.profiles
      .map((entry: unknown) => {
        try {
          return validateProfile(entry)
        } catch {
          return null
        }
      })
      .filter((profile: AgentProfile | null): profile is AgentProfile => profile !== null)
  } catch {
    return []
  }
}

/** Write custom profiles to disk. Pretty-printed. Contains no secrets. */
async function writeCustom(profiles: AgentProfile[]): Promise<void> {
  const file: ProfileStoreFile = { version: STORE_VERSION, profiles }
  await writeFile(storePath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

export class ProfileStore {
  private customProfiles: AgentProfile[] | null = null

  private customs(): AgentProfile[] {
    if (this.customProfiles === null) {
      this.customProfiles = readCustomSync()
    }
    return this.customProfiles
  }

  /** List all profiles: built-ins + custom. Custom profiles with matching ids override built-ins. */
  list(): AgentProfile[] {
    const custom = this.customs()
    const customIds = new Set(custom.map((p) => p.id))
    const builtins = BUILTIN_PROFILES.filter((p) => !customIds.has(p.id))
    return [...builtins, ...custom]
  }

  /** Get a single profile by id. Checks custom first, then built-ins. */
  get(id: string): AgentProfile | undefined {
    const custom = this.customs().find((p) => p.id === id)
    if (custom) return custom
    return BUILTIN_PROFILES.find((p) => p.id === id)
  }

  /** Save a custom profile. Creates or updates. Validates before persisting. */
  async save(raw: unknown): Promise<AgentProfile> {
    const profile = validateProfile(raw)
    if (profile.builtin) {
      throw new Error('Cannot save a profile marked as built-in. Clone it first.')
    }
    if (BUILTIN_PROFILES.some((p) => p.id === profile.id)) {
      throw new Error(`Cannot overwrite the built-in profile "${profile.id}". Clone it with a new id first.`)
    }
    profile.updatedAt = Date.now()
    if (!profile.createdAt) profile.createdAt = profile.updatedAt

    const customs = this.customs()
    const index = customs.findIndex((p) => p.id === profile.id)
    if (index >= 0) {
      // validateProfile strips metadata, so carry the original creation time over.
      profile.createdAt = customs[index].createdAt ?? profile.createdAt
      customs[index] = profile
    } else {
      customs.push(profile)
    }
    this.customProfiles = customs
    await writeCustom(customs)
    return profile
  }

  /** Delete a custom profile by id. Built-in profiles cannot be deleted. */
  async delete(id: string): Promise<boolean> {
    if (BUILTIN_PROFILES.some((p) => p.id === id)) {
      throw new Error('Cannot delete a built-in profile.')
    }
    const customs = this.customs()
    const index = customs.findIndex((p) => p.id === id)
    if (index < 0) return false
    customs.splice(index, 1)
    this.customProfiles = customs
    await writeCustom(customs)
    return true
  }

  /** Reset in-memory cache. Useful for testing. */
  reset(): void {
    this.customProfiles = null
  }
}

/** Main-process singleton instance. Lazy — no disk I/O at import time. */
export const profileStore = new ProfileStore()
