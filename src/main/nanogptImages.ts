/**
 * On-disk store for NanoGPT-generated images.
 *
 * Why images are persisted at all: a generated image is appended to the transcript as a synthetic
 * message with no server-side counterpart, so reloading a session would otherwise lose it. The PNG
 * bytes live on disk and the transcript is rehydrated from the index keyed by `sessionID`.
 *
 * Why the renderer is handed base64 rather than a path: the renderer CSP is
 * `img-src 'self' data: blob:` and the renderer is served from `file://` in production, so a
 * `file://` URL pointing into userData is NOT same-origin and would be blocked. Bytes therefore
 * cross IPC as base64 and become a `data:` URI. Listing returns METADATA ONLY so a large gallery
 * does not pull every image into renderer memory; `readImage` fetches bytes on demand.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { classifyBilling } from './nanogptBilling'

/** One generated image's metadata. Carries no pixel data — see `readImage`. */
export type GeneratedImageMeta = {
  id: string
  /** Session the generation was issued from, or null when generated from the Images view. */
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  /** Raw `paymentSource` from NanoGPT: 'subscription', a balance marker, or undefined if absent. */
  paymentSource?: string
  cost?: number
  createdAt: number
  bytes: number
}

type ImageIndex = { version: 1; images: GeneratedImageMeta[] }

/** Hard ceiling on retained generations; the oldest are pruned past this. */
const MAX_RETAINED = 500

function imagesDir(): string {
  const dir = join(app.getPath('userData'), 'nanogpt-images')
  mkdirSync(dir, { recursive: true })
  return dir
}

function indexPath(): string {
  return join(imagesDir(), 'index.json')
}

/**
 * Resolve an id to its PNG path, rejecting anything that is not a bare UUID-shaped token.
 *
 * The id reaches this module from the renderer over IPC, so it is untrusted input on a filesystem
 * path. An allowlisted character class is used rather than a traversal blocklist: `basename` alone
 * would still accept oddities, and there is no legitimate id outside this alphabet.
 */
function imagePath(id: string): string {
  if (!/^[a-f0-9-]{16,64}$/i.test(id) || basename(id) !== id) {
    throw new Error('Invalid image id.')
  }
  return join(imagesDir(), `${id}.png`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toMeta(value: unknown): GeneratedImageMeta | null {
  if (!isRecord(value)) return null
  const { id, prompt, model, createdAt, bytes } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof prompt !== 'string' || typeof model !== 'string') return null
  const meta: GeneratedImageMeta = {
    id,
    sessionID: typeof value.sessionID === 'string' ? value.sessionID : null,
    prompt,
    model,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  }
  if (typeof value.size === 'string') meta.size = value.size
  if (typeof value.paymentSource === 'string') meta.paymentSource = value.paymentSource
  if (typeof value.cost === 'number' && Number.isFinite(value.cost)) meta.cost = value.cost
  return meta
}

/** Shared parse/sanitize step for the index file contents (D3: dedupes the sync/async readers). */
function parseIndex(raw: string): ImageIndex {
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed) || !Array.isArray(parsed.images)) return { version: 1, images: [] }
  const images = parsed.images
    .map(toMeta)
    .filter((meta): meta is GeneratedImageMeta => meta !== null)
  return { version: 1, images }
}

/** Read the index synchronously. A missing or corrupt file reads as empty and never throws. */
export function readIndexSync(): ImageIndex {
  try {
    const path = indexPath()
    if (!existsSync(path)) return { version: 1, images: [] }
    return parseIndex(readFileSync(path, 'utf8'))
  } catch {
    return { version: 1, images: [] }
  }
}

/**
 * Read the index asynchronously. Missing file (ENOENT) reads as empty rather than probing with a
 * blocking `existsSync` first (D2) — that call was both a needless sync syscall in async code and a
 * TOCTOU window against a concurrent `deleteImage`/write.
 */
export async function readIndex(): Promise<ImageIndex> {
  try {
    const raw = await readFile(indexPath(), 'utf8')
    return parseIndex(raw)
  } catch {
    // ENOENT (no file yet) and corrupt/unreadable contents both read as an empty index.
    return { version: 1, images: [] }
  }
}

async function writeIndex(index: ImageIndex): Promise<void> {
  await writeFile(indexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/**
 * Serialize all `index.json` mutations behind a single module-level promise chain (D1).
 *
 * `saveImage`, `deleteImage`, and `reconcile` each do read-modify-write on the same file; without
 * this lock, concurrent callers interleave their reads and the last writer wins, silently dropping
 * every other caller's entry. Chaining every mutation onto `tail` forces them to run one at a time,
 * in call order, regardless of how many run concurrently at the call site.
 */
let tail: Promise<unknown> = Promise.resolve()
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn)
  // Swallow rejections in the chain itself so one failed mutation doesn't wedge the queue for
  // everyone after it; callers still observe their own rejection via `result`.
  tail = result.catch(() => undefined)
  return result
}

/** Newest first. Optionally scoped to one session for transcript rehydration. */
export async function listImages(sessionID?: string): Promise<GeneratedImageMeta[]> {
  const all = (await readIndex()).images
  const scoped = sessionID === undefined ? all : all.filter((meta) => meta.sessionID === sessionID)
  return [...scoped].sort((a, b) => b.createdAt - a.createdAt)
}

/** Persist one generated image and return its metadata. */
export async function saveImage(args: {
  base64: string
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  paymentSource?: string
  cost?: number
}): Promise<GeneratedImageMeta> {
  const buffer = Buffer.from(args.base64, 'base64')
  if (buffer.byteLength === 0) throw new Error('Refusing to store an empty image.')

  const id = randomUUID()
  await writeFile(imagePath(id), buffer)

  const meta: GeneratedImageMeta = {
    id,
    sessionID: args.sessionID,
    prompt: args.prompt,
    model: args.model,
    createdAt: Date.now(),
    bytes: buffer.byteLength
  }
  if (args.size !== undefined) meta.size = args.size
  if (args.paymentSource !== undefined) meta.paymentSource = args.paymentSource
  if (args.cost !== undefined) meta.cost = args.cost

  // Read-modify-write of index.json must be serialized (D1): each saveImage's PNG write is
  // independent and stays outside the lock, but the index mutation itself is queued behind
  // withIndexLock so concurrent calls never clobber each other's entry.
  await withIndexLock(async () => {
    const index = await readIndex()
    const images = [...index.images, meta]

    // Prune oldest past the cap, deleting their files too so the directory cannot grow unbounded.
    if (images.length > MAX_RETAINED) {
      const byAge = [...images].sort((a, b) => a.createdAt - b.createdAt)
      const excess = byAge.slice(0, images.length - MAX_RETAINED)
      for (const stale of excess) {
        try {
          await unlink(imagePath(stale.id))
        } catch {
          /* file already gone — the index entry is dropped either way */
        }
      }
      const dropped = new Set(excess.map((entry) => entry.id))
      await writeIndex({ version: 1, images: images.filter((entry) => !dropped.has(entry.id)) })
    } else {
      await writeIndex({ version: 1, images })
    }
  })

  return meta
}

/**
 * Read one image's bytes as base64 for display. Returns null when the file is gone.
 *
 * Goes straight to `readFile` and treats `ENOENT` as absent (D2) rather than probing with
 * `existsSync` first — that pattern is both a blocking syscall in async code and a TOCTOU window
 * against a concurrent `deleteImage` removing the file between the check and the read.
 */
export async function readImage(id: string): Promise<string | null> {
  try {
    const buffer = await readFile(imagePath(id))
    return buffer.toString('base64')
  } catch {
    return null
  }
}

/** Delete one image and its index entry. Safe to call for an unknown id. */
export async function deleteImage(id: string): Promise<void> {
  const path = imagePath(id)
  try {
    await unlink(path)
  } catch {
    /* best effort — ENOENT (already gone) or any other failure; the index entry is still removed below */
  }
  await withIndexLock(async () => {
    const index = await readIndex()
    await writeIndex({ version: 1, images: index.images.filter((meta) => meta.id !== id) })
  })
}

let lastReconcileAt = 0
const RECONCILE_THROTTLE_MS = 10_000

/**
 * Drop index entries whose PNG has vanished (manual deletion, failed write, disk repair) and
 * orphaned PNGs with no index entry. Keeps the gallery from showing permanently-broken tiles.
 */
export async function reconcile(options?: { force?: boolean }): Promise<{ removedEntries: number; removedFiles: number }> {
  const now = Date.now()
  if (!options?.force && now - lastReconcileAt < RECONCILE_THROTTLE_MS) {
    return { removedEntries: 0, removedFiles: 0 }
  }
  lastReconcileAt = now
  const dir = imagesDir()
  // The read-modify-write of index.json is serialized with saveImage/deleteImage (D1) so a
  // reconcile pass racing a concurrent save cannot drop an entry that was written after this
  // reconcile started reading.
  const { removedEntries, live } = await withIndexLock(async () => {
    const index = await readIndex()
    const liveImages = index.images.filter((meta) => {
      try {
        return existsSync(imagePath(meta.id))
      } catch {
        return false
      }
    })
    const removed = index.images.length - liveImages.length
    if (removed > 0) await writeIndex({ version: 1, images: liveImages })
    return { removedEntries: removed, live: liveImages }
  })

  const known = new Set(live.map((meta) => `${meta.id}.png`))
  let removedFiles = 0
  try {
    for (const name of await readdir(dir)) {
      if (name === 'index.json' || known.has(name)) continue
      if (!name.toLowerCase().endsWith('.png')) continue
      try {
        await unlink(join(dir, name))
        removedFiles += 1
      } catch {
        /* leave it; a locked file is not worth failing over */
      }
    }
  } catch {
    /* unreadable directory — nothing to reconcile */
  }
  return { removedEntries, removedFiles }
}

/** Documented free-tier allowance (contract T4): 100 images/day, reset 00:00 UTC. */
export const DAILY_FREE_IMAGE_CAP = 100

/**
 * Count images generated since UTC midnight that counted against the free-tier allowance.
 *
 * Entries billed to balance (per `classifyBilling`) are excluded — they did not consume the free
 * quota, so counting them would under-count remaining free generations.
 *
 * This is a local, best-effort figure, NOT an authoritative account-wide count: it only reflects
 * generations this install persisted, and it silently under-reports once retention
 * (`MAX_RETAINED`) or `reconcile()` has pruned older entries from today. There is no documented
 * endpoint to read the server's authoritative daily counter.
 */
export async function imagesToday(): Promise<number> {
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const cutoff = midnight.getTime()
  const index = await readIndex()
  return index.images.filter(
    (meta) => meta.createdAt >= cutoff && classifyBilling(meta.paymentSource) !== 'balance'
  ).length
}
