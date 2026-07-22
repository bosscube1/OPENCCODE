import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'

export type TrayOptions = {
  iconPath: string
  isMainWindowVisible: () => boolean
  onShow: () => void
  onHide: () => void
  onNewChat: () => void
  onQuickEntry: () => void
  onQuit: () => void
}

export type TrayController = {
  tray: Tray
  refresh(): void
  destroy(): void
}

/** Create the Windows-first system tray and its application actions. */
export function setupTray(options: TrayOptions): TrayController {
  const source = nativeImage.createFromPath(options.iconPath)
  const icon = process.platform === 'win32' && !source.isEmpty()
    ? source.resize({ width: 16, height: 16 })
    : source
  const tray = new Tray(icon)
  let destroyed = false

  const toggleWindow = (): void => {
    if (options.isMainWindowVisible()) options.onHide()
    else options.onShow()
    refresh()
  }

  const refresh = (): void => {
    if (destroyed || tray.isDestroyed()) return
    const template: MenuItemConstructorOptions[] = [
      {
        label: options.isMainWindowVisible() ? 'Hide OpenCode Desktop' : 'Show OpenCode Desktop',
        click: toggleWindow
      },
      { type: 'separator' },
      { label: 'New Chat', click: options.onNewChat },
      { label: 'Quick Entry', click: options.onQuickEntry },
      { type: 'separator' },
      { label: 'Quit', click: options.onQuit }
    ]
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  tray.setToolTip('OpenCode Desktop')
  tray.on('click', toggleWindow)
  tray.on('double-click', options.onShow)
  refresh()

  return {
    tray,
    refresh,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      tray.removeAllListeners()
      tray.destroy()
    }
  }
}
