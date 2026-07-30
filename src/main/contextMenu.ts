import {
  BrowserWindow,
  Menu,
  clipboard,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'

/**
 * Native right-click context menus.
 *
 * `buildContextMenuTemplate` is pure (no Electron `Menu`/popup calls) so it can be
 * unit-tested under Node without an Electron runtime. `attachContextMenu` wires it
 * up to a real `WebContents`'s `context-menu` event.
 */

const MAX_SPELLING_SUGGESTIONS = 5

export type ContextMenuActions = {
  replaceMisspelling(suggestion: string): void
  addToDictionary(word: string): void
  copyLink(url: string): void
  copyImage(x: number, y: number): void
  copyImageAddress(url: string): void
}

/** Build the context menu template from Electron's `ContextMenuParams`. Pure — no
 * Electron `Menu` or popup calls, so it is testable in a plain Node environment. */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, MAX_SPELLING_SUGGESTIONS)) {
      template.push({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion)
      })
    }
    template.push({ type: 'separator' })
    template.push({
      label: 'Add to Dictionary',
      click: () => actions.addToDictionary(params.misspelledWord)
    })
    template.push({ type: 'separator' })
  }

  if (params.isEditable) {
    template.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )
  } else if (params.selectionText.trim() !== '') {
    template.push({ role: 'copy' }, { role: 'selectAll' })
  } else if (!params.linkURL && params.mediaType !== 'image') {
    // Right-clicking read-only text with nothing selected — the common case in the chat
    // transcript. An empty menu here reads as "right-click is broken", so offer the one
    // action that is always meaningful. `copy` is listed but disabled so the menu shape
    // stays stable between the selected and unselected cases.
    template.push({ role: 'copy', enabled: false }, { role: 'selectAll' })
  }

  if (params.linkURL) {
    if (template.length > 0) template.push({ type: 'separator' })
    template.push({
      label: 'Copy Link',
      click: () => actions.copyLink(params.linkURL)
    })
  }

  if (params.mediaType === 'image' && params.srcURL) {
    if (template.length > 0) template.push({ type: 'separator' })
    template.push(
      {
        label: 'Copy Image',
        click: () => actions.copyImage(params.x, params.y)
      },
      {
        label: 'Copy Image Address',
        click: () => actions.copyImageAddress(params.srcURL)
      }
    )
  }

  return template
}

/** Subscribe a `WebContents` to native right-click context menus (spelling, edit,
 * selection, link, and image actions). No-ops if the built template is empty, so a
 * background right-click never flashes an empty native menu. */
export function attachContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const actions: ContextMenuActions = {
      replaceMisspelling: (suggestion) => contents.replaceMisspelling(suggestion),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      copyLink: (url) => clipboard.writeText(url),
      copyImage: (x, y) => contents.copyImageAt(x, y),
      copyImageAddress: (url) => clipboard.writeText(url)
    }

    const template = buildContextMenuTemplate(params, actions)
    if (template.length === 0) return

    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
  })
}
