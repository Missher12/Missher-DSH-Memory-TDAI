export function resolveDashboardTheme(colorScheme: string | undefined, systemDark: boolean): 'light' | 'dark'
export function observeDashboardTheme(root: HTMLElement, onTheme: (theme: 'light' | 'dark') => void): () => void
