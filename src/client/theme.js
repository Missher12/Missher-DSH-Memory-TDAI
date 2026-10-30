export function resolveDashboardTheme(colorScheme, systemDark) {
  const schemes = String(colorScheme ?? '').trim().toLowerCase().split(/\s+/u)
  const light = schemes.includes('light')
  const dark = schemes.includes('dark')
  if (light !== dark) return dark ? 'dark' : 'light'
  return systemDark ? 'dark' : 'light'
}

/** Read above the plugin's own palette, and observe only Host ancestors/styles and the OS. */
export function observeDashboardTheme(root, onTheme) {
  const document = root.ownerDocument
  const view = document.defaultView
  if (view === null) return () => {}
  const media = view.matchMedia?.('(prefers-color-scheme: dark)')
  let frame
  let disposed = false
  let previous
  const refresh = () => {
    if (disposed) return
    const parent = root.parentElement ?? document.documentElement
    const theme = resolveDashboardTheme(view.getComputedStyle(parent).colorScheme, media?.matches === true)
    if (theme !== previous) { previous = theme; onTheme(theme) }
  }
  const schedule = () => {
    if (disposed || frame !== undefined) return
    frame = view.requestAnimationFrame(() => { frame = undefined; refresh() })
  }
  const observer = new view.MutationObserver(schedule)
  for (let parent = root.parentElement; parent !== null; parent = parent.parentElement) {
    observer.observe(parent, { attributes: true })
  }
  if (document.head !== null) observer.observe(document.head, { attributes: true, childList: true, characterData: true, subtree: true })
  media?.addEventListener('change', schedule)
  refresh()
  return () => {
    disposed = true
    observer.disconnect()
    media?.removeEventListener('change', schedule)
    if (frame !== undefined) view.cancelAnimationFrame(frame)
  }
}
