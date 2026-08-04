import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  GeneratedImageMeta,
  ImageBilling,
  NanogptGenerateArgs,
  NanogptGenerateResult,
  NanogptModelsResult
} from '../lib/types'
import { DAILY_FREE_IMAGE_CAP } from '../lib/types'
import { useStore } from '../lib/store'
import { canGenerateWith, label, pickDefaultImageModel, sortImageModels } from '../lib/imageModels'
import { relativeTime } from '../lib/format'
import { ImageLightbox } from './ImageLightbox'
import './images.css'

const SIZE_OPTIONS = ['1024x1024', '512x512', '768x768', '1024x1536', '1536x1024'] as const
const AUTO_SIZE = 'auto'
const COUNT_OPTIONS = [1, 2, 3, 4] as const
/** How many tile reads may be in flight at once — keeps the gallery from firing a burst of IPC calls. */
const MAX_CONCURRENT_READS = 3

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Mirrors the main process's `classifyBilling` — an absent field is 'unknown', never assumed. */
function metaBilling(meta: GeneratedImageMeta): ImageBilling {
  if (meta.paymentSource === undefined || meta.paymentSource.trim().length === 0) return 'unknown'
  return meta.paymentSource.toLowerCase().includes('subscription') ? 'subscription' : 'balance'
}

function billingLabel(b: ImageBilling): string {
  if (b === 'subscription') return 'Subscription'
  if (b === 'balance') return 'Balance'
  return 'Unknown'
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Documented machine-readable error codes (contract T6) worth a specific message. `err.code`
 * rarely survives the IPC boundary (Electron's `ipcMain.handle` rejection does not preserve
 * custom Error properties), so this also falls back to matching the code token inside the raw
 * message text — main includes the raw JSON error body snippet in the thrown message, so the
 * code string is present there even when the property is gone.
 */
const DOCUMENTED_GENERATE_ERRORS: Record<string, string> = {
  content_policy_violation:
    'NanoGPT rejected this prompt for its content policy. Not billed — try a different prompt.',
  daily_rpd_limit_exceeded:
    'Daily request limit reached on your NanoGPT plan. Try again after it resets.',
  daily_usd_limit_exceeded:
    'Daily spend limit reached on your NanoGPT plan. Try again after it resets.',
  insufficient_balance:
    'Your NanoGPT pay-per-prompt balance is too low to cover this request.'
}

function describeGenerateError(e: unknown): string {
  const raw = errMessage(e)
  const codeProp = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined
  const matched =
    (codeProp && codeProp in DOCUMENTED_GENERATE_ERRORS ? codeProp : undefined) ??
    Object.keys(DOCUMENTED_GENERATE_ERRORS).find((code) => raw.includes(code))
  return matched ? DOCUMENTED_GENERATE_ERRORS[matched] : raw
}

/**
 * A tiny concurrency-limited async queue, scoped to one ImagesView mount.
 * Bounds how many `images.read` IPC calls (each a full PNG's worth of base64) can be in flight at
 * once, so scrolling a large gallery quickly cannot fan out unbounded concurrent reads.
 */
function useReadLimiter(): (id: string) => Promise<string | null> {
  const limiterRef = useRef<{ active: number; queue: Array<() => void> }>({ active: 0, queue: [] })

  return useCallback((id: string) => {
    return new Promise<string | null>((resolve, reject) => {
      const state = limiterRef.current
      const run = (): void => {
        state.active += 1
        window.api.nanogpt.images
          .read(id)
          .then(resolve, reject)
          .finally(() => {
            state.active -= 1
            const nextRun = state.queue.shift()
            if (nextRun) nextRun()
          })
      }
      if (state.active < MAX_CONCURRENT_READS) run()
      else state.queue.push(run)
    })
  }, [])
}

interface ImageTileProps {
  meta: GeneratedImageMeta
  initialBase64?: string
  requestRead: (id: string) => Promise<string | null>
  onOpen: (src: string, alt: string) => void
  onSave: (meta: GeneratedImageMeta, base64: string) => void
  onDelete: (id: string) => void
}

/**
 * One gallery tile. Bytes are metadata-only until this tile scrolls near the viewport — the
 * IntersectionObserver below is what keeps a large gallery from holding every image in memory at
 * once, per the "no eager reads" requirement.
 */
function ImageTile({ meta, initialBase64, requestRead, onOpen, onSave, onDelete }: ImageTileProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const requestedRef = useRef(Boolean(initialBase64))
  const [base64, setBase64] = useState<string | null>(initialBase64 ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (requestedRef.current) return
    const node = containerRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (requestedRef.current || !entries.some((entry) => entry.isIntersecting)) return
        requestedRef.current = true
        observer.disconnect()
        setLoading(true)
        setFailed(false)
        requestRead(meta.id)
          .then((data) => {
            if (data === null) setFailed(true)
            else setBase64(data)
          })
          .catch(() => setFailed(true))
          .finally(() => setLoading(false))
      },
      { rootMargin: '200px', threshold: 0.01 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [meta.id, requestRead])

  const ensureLoaded = useCallback(async (): Promise<string | null> => {
    if (base64) return base64
    setLoading(true)
    setFailed(false)
    try {
      const data = await requestRead(meta.id)
      if (data === null) setFailed(true)
      else setBase64(data)
      return data
    } catch {
      setFailed(true)
      return null
    } finally {
      setLoading(false)
    }
  }, [base64, meta.id, requestRead])

  const handleSaveClick = useCallback(() => {
    void ensureLoaded().then((data) => {
      if (data) onSave(meta, data)
    })
  }, [ensureLoaded, meta, onSave])

  const handleDeleteClick = useCallback(() => {
    if (!window.confirm('Delete this image? This cannot be undone.')) return
    onDelete(meta.id)
  }, [meta.id, onDelete])

  const billing = metaBilling(meta)
  const dataUrl = base64 ? `data:image/png;base64,${base64}` : null

  return (
    <div className="images__tile" ref={containerRef}>
      <button
        type="button"
        className="images__thumb-btn"
        title={meta.prompt}
        disabled={!dataUrl}
        onClick={() => dataUrl && onOpen(dataUrl, meta.prompt)}
      >
        {dataUrl ? (
          <img className="images__thumb" src={dataUrl} alt={meta.prompt} />
        ) : (
          <div className={failed ? 'images__thumb-placeholder images__thumb-placeholder--error' : 'images__thumb-placeholder'}>
            {failed ? 'Failed to load' : loading ? 'Loading…' : ''}
          </div>
        )}
      </button>
      <div className="images__tile-info">
        <p className="images__tile-prompt" title={meta.prompt}>
          {truncate(meta.prompt, 70)}
        </p>
        <div className="images__tile-meta">
          <span className="images__tile-model" title={meta.model}>
            {meta.model}
          </span>
          <span className={`images__badge images__badge--${billing}`}>{billingLabel(billing)}</span>
          <span className="images__tile-time">{relativeTime(meta.createdAt)}</span>
        </div>
        <div className="images__tile-actions">
          <button type="button" onClick={handleSaveClick} disabled={loading}>
            Save
          </button>
          <button type="button" className="images__tile-delete" onClick={handleDeleteClick}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export function ImagesView(): JSX.Element {
  const subscriptionOnly = useStore((s) => s.appSettings.nanogptSubscriptionOnly)
  const requestRead = useReadLimiter()

  const [catalogue, setCatalogue] = useState<NanogptModelsResult | null>(null)
  const [catalogueLoading, setCatalogueLoading] = useState(true)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)

  const [promptText, setPromptText] = useState('')
  const [modelID, setModelID] = useState('')
  const [size, setSize] = useState<string>(AUTO_SIZE)
  const [count, setCount] = useState(1)

  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<NanogptGenerateResult | null>(null)
  /** Bytes for images generated this session — skips a redundant `images.read` right after `generate`. */
  const [freshBytes, setFreshBytes] = useState<Record<string, string>>({})

  const [gallery, setGallery] = useState<GeneratedImageMeta[]>([])
  const [galleryLoading, setGalleryLoading] = useState(true)
  const [galleryError, setGalleryError] = useState<string | null>(null)
  const [todayCount, setTodayCount] = useState<number | null>(null)

  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)

  const loadCatalogue = useCallback(async (): Promise<void> => {
    setCatalogueLoading(true)
    setCatalogueError(null)
    try {
      const result = await window.api.nanogpt.models()
      setCatalogue(result)
    } catch (e) {
      setCatalogueError(errMessage(e))
    } finally {
      setCatalogueLoading(false)
    }
  }, [])

  const loadGallery = useCallback(async (): Promise<void> => {
    setGalleryLoading(true)
    setGalleryError(null)
    try {
      const [metas, today] = await Promise.all([
        window.api.nanogpt.images.list(),
        window.api.nanogpt.images.today()
      ])
      setGallery([...metas].sort((a, b) => b.createdAt - a.createdAt))
      setTodayCount(today)
    } catch (e) {
      setGalleryError(errMessage(e))
    } finally {
      setGalleryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCatalogue()
    void loadGallery()
  }, [loadCatalogue, loadGallery])

  // Keep the model selection valid: pick a default once the catalogue arrives, and steer away from a
  // model that just became balance-billed (or newly disallowed by the subscription-only toggle).
  useEffect(() => {
    if (!catalogue) return
    setModelID((current) => {
      const stillUsable =
        current.length > 0 &&
        catalogue.image.some((m) => m.id === current) &&
        canGenerateWith(current, catalogue.balanceBilled, subscriptionOnly)
      if (stillUsable) return current
      return pickDefaultImageModel(catalogue.image, catalogue.balanceBilled, subscriptionOnly) ?? ''
    })
  }, [catalogue, subscriptionOnly])

  const handleGenerate = useCallback(async (): Promise<void> => {
    const trimmed = promptText.trim()
    if (trimmed.length === 0 || modelID.length === 0 || generating) return
    if (!catalogue || !canGenerateWith(modelID, catalogue.balanceBilled, subscriptionOnly)) return

    setGenerating(true)
    setGenerateError(null)
    try {
      const args: NanogptGenerateArgs = { prompt: trimmed, model: modelID, n: count }
      if (size !== AUTO_SIZE) args.size = size
      const result = await window.api.nanogpt.generate(args)
      setLastResult(result)
      if (result.images.length > 0) {
        setFreshBytes((prev) => {
          const next = { ...prev }
          for (const image of result.images) next[image.meta.id] = image.base64
          return next
        })
        setGallery((prev) => [...result.images.map((image) => image.meta), ...prev])
      }
      if (result.blacklisted) void loadCatalogue()
    } catch (e) {
      setGenerateError(describeGenerateError(e))
    } finally {
      setGenerating(false)
    }
  }, [promptText, modelID, generating, catalogue, subscriptionOnly, count, size, loadCatalogue])

  const handleSave = useCallback((meta: GeneratedImageMeta, base64: string): void => {
    const safeModel = meta.model.replace(/[^a-zA-Z0-9._-]/g, '_')
    window.api
      .saveFile({ defaultName: `${safeModel}-${meta.id}.png`, content: base64, encoding: 'base64' })
      .catch((e: unknown) => setGalleryError(errMessage(e)))
  }, [])

  const handleDelete = useCallback((id: string): void => {
    window.api.nanogpt.images
      .remove(id)
      .then(() => {
        setGallery((prev) => prev.filter((m) => m.id !== id))
        setFreshBytes((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      })
      .catch((e: unknown) => setGalleryError(errMessage(e)))
  }, [])

  const catalogueImages = catalogue?.image ?? []
  const balanceBilled = catalogue?.balanceBilled ?? []
  const sortedModels = sortImageModels(catalogueImages, balanceBilled)
  const balanceBilledSet = new Set(balanceBilled)

  const canGenerate =
    !generating &&
    !catalogueLoading &&
    promptText.trim().length > 0 &&
    modelID.length > 0 &&
    catalogueImages.length > 0 &&
    canGenerateWith(modelID, balanceBilled, subscriptionOnly)

  return (
    <section className="images" aria-label="Images">
      <header className="images__header">
        <h1>Images</h1>
        <p>Generate images with NanoGPT and browse everything you have made.</p>
      </header>

      <p className="images__notice">
        NanoGPT does not publish which image models are covered by the subscription — the first
        generation on an untested model is what reveals it, from the billing source in the response.
        Any model found to bill your balance is then blocked here while “Subscription images only” is
        on.
      </p>

      {catalogueError && (
        <div className="images__message images__message--error" role="alert">
          {catalogueError}
        </div>
      )}

      {!catalogueLoading && catalogueImages.length === 0 && !catalogueError && (
        <div className="images__empty-catalogue">
          No NanoGPT image models are cached yet. Open <strong>Providers → NanoGPT</strong> and choose{' '}
          <strong>Refresh models</strong>.
        </div>
      )}

      <div className="images__composer">
        <textarea
          className="images__prompt-input"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              void handleGenerate()
            }
          }}
          placeholder="Describe the image you want to generate… (Ctrl+Enter to generate)"
          disabled={catalogueImages.length === 0}
        />

        <div className="images__controls">
          <label className="images__field images__field--model">
            Model
            <select value={modelID} onChange={(e) => setModelID(e.target.value)} disabled={sortedModels.length === 0}>
              {sortedModels.length === 0 && <option value="">No models available</option>}
              {sortedModels.map((m) => {
                const billed = balanceBilledSet.has(m.id)
                return (
                  <option key={m.id} value={m.id} disabled={!canGenerateWith(m.id, balanceBilled, subscriptionOnly)}>
                    {label(m)}
                    {billed ? ' (billed to balance)' : ''}
                  </option>
                )
              })}
            </select>
          </label>

          <label className="images__field">
            Size
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value={AUTO_SIZE}>Auto (model default)</option>
              {SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="images__field">
            Count
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {COUNT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="images__generate" onClick={() => void handleGenerate()} disabled={!canGenerate}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      {generateError && (
        <div className="images__message images__message--error" role="alert">
          {generateError}
        </div>
      )}

      {lastResult && (
        <div className="images__result" role="status">
          <span className={`images__badge images__badge--${lastResult.billing}`}>{billingLabel(lastResult.billing)}</span>
          {typeof lastResult.cost === 'number' && <span>Cost: {lastResult.cost}</span>}
          {typeof lastResult.remainingBalance === 'number' && (
            <span>Balance remaining: {lastResult.remainingBalance}</span>
          )}
          {lastResult.blacklisted && (
            <p className="images__result-warn">
              This model has been marked as balance-billing and will now be refused while “Subscription
              images only” is on.
            </p>
          )}
        </div>
      )}

      <div className="images__gallery-head">
        <h2>Gallery</h2>
        <div className="images__gallery-count">
          {todayCount !== null && (
            <span title="Counted from this device's local image index — not the NanoGPT account.">
              {todayCount}/{DAILY_FREE_IMAGE_CAP} generated today (this device)
            </span>
          )}
          {galleryLoading && <span className="images__gallery-loading">Loading…</span>}
        </div>
      </div>

      {galleryError && (
        <div className="images__message images__message--error" role="alert">
          {galleryError}
        </div>
      )}

      {gallery.length === 0 && !galleryLoading ? (
        <p className="images__empty">No images generated yet.</p>
      ) : (
        <div className="images__grid">
          {gallery.map((meta) => (
            <ImageTile
              key={meta.id}
              meta={meta}
              initialBase64={freshBytes[meta.id]}
              requestRead={requestRead}
              onOpen={(src, alt) => setLightbox({ src, alt })}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </section>
  )
}
