import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuParams } from 'electron'
import { buildContextMenuTemplate, type ContextMenuActions } from '../contextMenu'

/** Electron's ContextMenuParams has many fields we don't use; fill in reasonable
 * defaults and let callers override just what a given test cares about. */
function makeParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    linkURL: '',
    linkText: '',
    pageURL: '',
    frameURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: 'UTF-8',
    inputFieldType: 'none',
    spellcheckEnabled: false,
    menuSourceType: 'none',
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canRotate: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canLoop: false
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false
    },
    ...overrides
  } as ContextMenuParams
}

function makeActions(): ContextMenuActions {
  return {
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn(),
    copyLink: vi.fn(),
    copyImage: vi.fn(),
    copyImageAddress: vi.fn()
  }
}

describe('buildContextMenuTemplate', () => {
  it('still yields a usable menu for otherwise-empty params', () => {
    const template = buildContextMenuTemplate(makeParams(), makeActions())
    expect(template.map((item) => item.role)).toEqual(['copy', 'selectAll'])
  })

  it('produces cut/copy/paste roles for editable fields', () => {
    const params = makeParams({
      isEditable: true,
      editFlags: {
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
        canEditRichly: true
      }
    })
    const template = buildContextMenuTemplate(params, makeActions())
    const roles = template.map((item) => item.role)
    expect(roles).toContain('cut')
    expect(roles).toContain('copy')
    expect(roles).toContain('paste')
    expect(roles).toContain('pasteAndMatchStyle')
    expect(roles).toContain('undo')
    expect(roles).toContain('redo')
    expect(roles).toContain('selectAll')
  })

  it('disables items whose editFlags say they are unavailable', () => {
    const params = makeParams({
      isEditable: true,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false
      }
    })
    const template = buildContextMenuTemplate(params, makeActions())
    const byRole = (role: string): (typeof template)[number] | undefined =>
      template.find((item) => item.role === role)
    expect(byRole('undo')?.enabled).toBe(false)
    expect(byRole('redo')?.enabled).toBe(false)
    expect(byRole('cut')?.enabled).toBe(false)
    expect(byRole('copy')?.enabled).toBe(true)
    expect(byRole('paste')?.enabled).toBe(false)
    expect(byRole('selectAll')?.enabled).toBe(true)
  })

  it('produces copy but no paste for selection-only (non-editable) text', () => {
    const params = makeParams({ isEditable: false, selectionText: 'hello world' })
    const template = buildContextMenuTemplate(params, makeActions())
    const roles = template.map((item) => item.role)
    expect(roles).toContain('copy')
    expect(roles).toContain('selectAll')
    expect(roles).not.toContain('paste')
    expect(roles).not.toContain('cut')
  })

  it('falls back to a disabled Copy plus Select All on read-only text with no selection', () => {
    // Right-clicking the chat transcript with nothing selected. An empty menu here would
    // read as "right-click is broken", so a stable, mostly-disabled menu is shown instead.
    const params = makeParams({ isEditable: false, selectionText: '   ' })
    const template = buildContextMenuTemplate(params, makeActions())
    expect(template.map((item) => item.role)).toEqual(['copy', 'selectAll'])
    expect(template[0].enabled).toBe(false)
  })

  it('does not add the read-only fallback when a link or image supplies real actions', () => {
    const linkTemplate = buildContextMenuTemplate(
      makeParams({ isEditable: false, selectionText: '', linkURL: 'https://example.com' }),
      makeActions()
    )
    expect(linkTemplate.map((item) => item.label)).toEqual(['Copy Link'])
    expect(linkTemplate.some((item) => item.role === 'selectAll')).toBe(false)
  })

  it('puts spelling suggestions first, capped at 5, followed by Add to Dictionary', () => {
    const params = makeParams({
      isEditable: true,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'teal', 'team', 'text'],
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: false,
        canEditRichly: false
      }
    })
    const actions = makeActions()
    const template = buildContextMenuTemplate(params, actions)

    const suggestionLabels = ['the', 'ten', 'tea', 'tech', 'teal']
    expect(template.slice(0, 5).map((item) => item.label)).toEqual(suggestionLabels)
    expect(template[5]?.type).toBe('separator')
    expect(template[6]?.label).toBe('Add to Dictionary')
    expect(template[7]?.type).toBe('separator')

    const firstSuggestion = template[0]
    expect(firstSuggestion?.click).toBeTypeOf('function')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(firstSuggestion?.click as any)?.()
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('the')

    const addToDictionaryItem = template[6]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(addToDictionaryItem?.click as any)?.()
    expect(actions.addToDictionary).toHaveBeenCalledWith('teh')
  })

  it('appends Copy Link when linkURL is present, with a separator before it', () => {
    const params = makeParams({
      isEditable: false,
      selectionText: 'some text',
      linkURL: 'https://example.com'
    })
    const actions = makeActions()
    const template = buildContextMenuTemplate(params, actions)

    const shapes = template.map((item) => item.role ?? item.type ?? item.label)
    expect(shapes).toEqual(['copy', 'selectAll', 'separator', 'Copy Link'])

    const copyLinkItem = template[template.length - 1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(copyLinkItem?.click as any)?.()
    expect(actions.copyLink).toHaveBeenCalledWith('https://example.com')
  })

  it('adds Copy Link with no leading separator when the template was otherwise empty', () => {
    const params = makeParams({ linkURL: 'https://example.com' })
    const template = buildContextMenuTemplate(params, makeActions())
    expect(template).toHaveLength(1)
    expect(template[0]?.label).toBe('Copy Link')
  })

  it('adds image items when mediaType is image and srcURL is present', () => {
    const params = makeParams({ mediaType: 'image', srcURL: 'https://example.com/pic.png' })
    const actions = makeActions()
    const template = buildContextMenuTemplate(params, actions)
    const labels = template.map((item) => item.label)
    expect(labels).toEqual(['Copy Image', 'Copy Image Address'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(template[0]?.click as any)?.()
    expect(actions.copyImage).toHaveBeenCalledWith(0, 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(template[1]?.click as any)?.()
    expect(actions.copyImageAddress).toHaveBeenCalledWith('https://example.com/pic.png')
  })
})
