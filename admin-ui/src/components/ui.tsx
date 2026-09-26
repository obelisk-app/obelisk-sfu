// Small shared UI helpers — same look as agents.obelisk.ar.
import { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { nip19 } from 'nostr-tools'

export const npub = (hex: string) => { try { return nip19.npubEncode(hex) } catch { return hex } }
export const shortNpub = (hex: string | null | undefined) => {
  if (!hex) return '—'
  const n = npub(hex)
  return `${n.slice(0, 12)}…${n.slice(-6)}`
}

/** "12s" / "4m" / "3h" / "2d" for a unix-seconds timestamp; "—" for null. */
export const age = (ts: number | null | undefined) => {
  if (ts == null) return '—'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function Avatar({ picture, label, size = 40, rounded = 'full' }: {
  picture?: string | null
  label: string
  size?: number
  rounded?: 'xl' | 'full'
}) {
  const [broken, setBroken] = useState(false)
  const initials = label.split(/[-_\s]+/).filter(Boolean).map((w) => [...w][0]).join('').slice(0, 2).toUpperCase() || '?'
  const radius = rounded === 'full' ? '9999px' : `${Math.round(size * 0.28)}px`
  return (
    <span class="lc-avatar" style={{ width: `${size}px`, height: `${size}px`, borderRadius: radius }}>
      {picture && !broken ? (
        <img src={picture} alt="" loading="lazy" referrerpolicy="no-referrer" style={{ borderRadius: radius }}
          onError={() => setBroken(true)} />
      ) : (
        <span class="lc-avatar-mono" style={{ borderRadius: radius, fontSize: `${Math.max(11, Math.round(size * 0.36))}px` }}>
          {initials}
        </span>
      )}
    </span>
  )
}

export function Section({ title, subtitle, actions, children }: {
  title: string
  subtitle?: ComponentChildren
  actions?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <section class="lc-card p-5 mb-6">
      <div class="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 class="font-bold text-lg">{title}</h2>
          {subtitle && <p class="text-xs text-lc-muted mt-1 max-w-2xl">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button class="font-mono text-xs text-lc-muted hover:text-lc-green transition-colors" title={text}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}>
      {copied ? '✓ copied' : label}
    </button>
  )
}

export function Stat({ label, value, hint, accent = false }: {
  label: string; value: ComponentChildren; hint?: ComponentChildren; accent?: boolean
}) {
  return (
    <div class="lc-stat">
      <div class="text-[11px] font-bold uppercase tracking-wider text-lc-muted">{label}</div>
      <div class={`text-2xl font-extrabold mt-1 ${accent ? 'text-lc-green' : ''}`}>{value}</div>
      {hint && <div class="text-[11px] text-lc-muted mt-0.5">{hint}</div>}
    </div>
  )
}

const iconBase = {
  fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
  'stroke-linejoin': 'round', viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true',
} as const

export const Icon = {
  overview: () => <svg {...iconBase}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>,
  access: () => <svg {...iconBase}><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>,
  settings: () => <svg {...iconBase}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  test: () => <svg {...iconBase}><path d="M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3" /></svg>,
  logout: () => <svg {...iconBase}><path d="M15 17l5-5-5-5M20 12H9M11 21H5a1 1 0 01-1-1V4a1 1 0 011-1h6" /></svg>,
  menu: () => <svg {...iconBase}><path d="M4 7h16M4 12h16M4 17h16" /></svg>,
  bolt: () => <svg {...iconBase} width={16} height={16}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>,
  plus: () => <svg {...iconBase} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>,
  search: () => <svg {...iconBase} width={16} height={16}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  restart: () => <svg {...iconBase} width={14} height={14}><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" /></svg>,
}
