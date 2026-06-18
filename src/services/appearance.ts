// Runtime theming + UI scaling.
//
// We never generate Tailwind classes at runtime (JIT would purge them). Instead
// we override the *values* of the design tokens — the `@theme` vars in style.css
// (`--color-bg`, `--color-accent`, …) and their legacy `:root`/dockview aliases.
// Every existing utility (`bg-bg`, `text-accent`, the dockview theme, scoped
// styles) re-colors live because they all resolve through `var(--…)`.
//
// UI scale uses CSS `zoom` on the document root, which scales the whole chrome
// uniformly (px-based layout, so `rem` tricks wouldn't reach most of it). The
// editor keeps its own finer font-size control on top of this.

export type ThemeToken =
  | 'bg' | 'surface' | 'elevated' | 'hover' | 'active' | 'line'
  | 'fg' | 'muted' | 'subtle' | 'accent' | 'green' | 'yellow' | 'red'

export type Palette = Record<ThemeToken, string>

export interface ThemePreset {
  id: string
  label: string
  palette: Palette
}

// Each preset is a full token set. The user's accent choice overrides the
// preset's `accent` (see paletteFor) so accents survive a theme switch.
export const themePresets: ThemePreset[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    palette: {
      bg: '#1e1e1e', surface: '#262626', elevated: '#2d2d2d', hover: '#353535',
      active: '#3e3e3e', line: '#353535', fg: '#e0e0e0', muted: '#a3a3a3',
      subtle: '#767676', accent: '#F2778A', green: '#87a03b', yellow: '#f08501',
      red: '#ff9200',
    },
  },
  {
    id: 'dim',
    label: 'Dim',
    palette: {
      bg: '#1a1b26', surface: '#1f2030', elevated: '#24283b', hover: '#292e42',
      active: '#2f344d', line: '#2f3549', fg: '#c0caf5', muted: '#9aa5ce',
      subtle: '#565f89', accent: '#7aa2f7', green: '#9ece6a', yellow: '#e0af68',
      red: '#f7768e',
    },
  },
  {
    id: 'contrast',
    label: 'High contrast',
    palette: {
      bg: '#05080d', surface: '#0a0f16', elevated: '#0f151e', hover: '#161d28',
      active: '#1d2632', line: '#2b3543', fg: '#f2f5f9', muted: '#b9c2cd',
      subtle: '#6b7682', accent: '#8ab4ff', green: '#b9f27c', yellow: '#f2c46a',
      red: '#ff8aa0',
    },
  },
]

export interface AppearanceSettings {
  /** Theme preset id (see themePresets). */
  theme: string
  /** Accent override, applied on top of the preset. */
  accent: string
  /** Chrome scale, 0.8–1.5 (1 = 100%). */
  uiScale: number
}

export const defaultAppearance: AppearanceSettings = {
  theme: 'midnight',
  accent: themePresets[0].palette.accent,
  uiScale: 1,
}

/** Handy accent choices surfaced as swatches in the settings UI. */
export const accentSwatches = ['#F2778A', '#87a03b', '#f08501', '#ff9200', '#48BA7D', '#2d97de']

// token → legacy `:root` variable (consumed by scoped styles + the dockview theme).
const legacyVar: Record<ThemeToken, string> = {
  bg: '--bg', surface: '--bg-panel', elevated: '--bg-input', hover: '--bg-hover',
  active: '--bg-active', line: '--border', fg: '--fg', muted: '--fg-muted',
  subtle: '--fg-subtle', accent: '--accent', green: '--green', yellow: '--yellow',
  red: '--red',
}

const MIN_SCALE = 0.8
const MAX_SCALE = 1.5

export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n))
}

/** Resolved palette for a given appearance (preset + accent override). */
export function paletteFor(a: AppearanceSettings): Palette {
  const preset = themePresets.find((p) => p.id === a.theme) ?? themePresets[0]
  return { ...preset.palette, accent: a.accent || preset.palette.accent }
}

/** Push the appearance into the live document (tokens + zoom). Idempotent. */
export function applyAppearance(a: AppearanceSettings): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const palette = paletteFor(a)
  for (const token of Object.keys(palette) as ThemeToken[]) {
    const value = palette[token]
    root.style.setProperty(`--color-${token}`, value)
    root.style.setProperty(legacyVar[token], value)
  }
  root.style.setProperty('zoom', String(clampScale(a.uiScale)))
}
