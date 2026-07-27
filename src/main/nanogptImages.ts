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
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

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

/** Read the index. A missing or corrupt file reads as empty and never throws. */
export function readIndex(): ImageIndex {
  try {
    const path = indexPath()
    if (!existsSync(path)) return { version: 1, images: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.images)) return { version: 1, images: [] }
    const images = parsed.images
      .map(toMeta)
      .filter((meta): meta is GeneratedImageMeta => meta !== null)
    return { version: 1, images }
  } catch {
    return { version: 1, images: [] }
  }
}

function writeIndex(index: ImageIndex): void {
  writeFileSync(indexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/** Newest first. Optionally scoped to one session for transcript rehydration. */
export function listImages(sessionID?: string): GeneratedImageMeta[] {
  const all = readIndex().images
  const scoped = sessionID === undefined ? all : all.filter((meta) => meta.sessionID === sessionID)
  return [...scoped].sort((a, b) => b.createdAt - a.createdAt)
}

/** Persist one generated image and return its metadata. */
export function saveImage(args: {
  base64: string
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  paymentSource?: string
  cost?: number
}): GeneratedImageMeta {
  const buffer = Buffer.from(args.base64, 'base64')
  if (buffer.byteLength === 0) throw new Error('Refusing to store an empty image.')

  const id = randomUUID()
  writeFileSync(imagePath(id), buffer)

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

  const index = readIndex()
  const images = [...index.images, meta]

  // Prune oldest past the cap, deleting their files too so the directory cannot grow unbounded.
  if (images.length > MAX_RETAINED) {
    const byAge = [...images].sort((a, b) => a.createdAt - b.createdAt)
    const excess = byAge.slice(0, images.length - MAX_RETAINED)
    for (const stale of excess) {
      try {
        unlinkSync(imagePath(stale.id))
      } catch {
        /* file already gone — the index entry is dropped either way */
      }
    }
    const dropped = new Set(excess.map((entry) => entry.id))
    writeIndex({ version: 1, images: images.filter((entry) => !dropped.has(entry.id)) })
  } else {
    writeIndex({ version: 1, images })
  }

  return meta
}

/** Read one image's bytes as base64 for display. Returns null when the file is gone. */
export function readImage(id: string): string | null {
  try {
    const path = imagePath(id)
    if (!existsSync(path)) return null
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

/** Delete one image and its index entry. Safe to call for an unknown id. */
export function deleteImage(id: string): void {
  const path = imagePath(id)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best effort — the index entry is still removed below */
  }
  const index = readIndex()
  writeIndex({ version: 1, images: index.images.filter((meta) => meta.id !== id) })
}

/**
 * Drop index entries whose PNG has vanished (manual deletion, failed write, disk repair) and
 * orphaned PNGs with no index entry. Keeps the gallery from showing permanently-broken tiles.
 */
export function reconcile(): { removedEntries: number; removedFiles: number } {
  const dir = imagesDir()
  const index = readIndex()
  const live = index.images.filter((meta) => {
    try {
      return existsSync(imagePath(meta.id))
    } catch {
      return false
    }
  })
  const removedEntries = index.images.length - live.length
  if (removedEntries > 0) writeIndex({ version: 1, images: live })

  const known = new Set(live.map((meta) => `${meta.id}.png`))
  let removedFiles = 0
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'index.json' || known.has(name)) continue
      if (!name.toLowerCase().endsWith('.png')) continue
      try {
        unlinkSync(join(dir, name))
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
