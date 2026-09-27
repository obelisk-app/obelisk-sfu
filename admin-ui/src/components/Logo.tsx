import { useId } from 'preact/hooks'

// Obelisk SFU mark: a forwarding hub — one ringed node routing to four peers —
// on the family's green tile. Inline rather than an <img> so it renders with
// the first paint; the same drawing is src/assets/logo.svg (the favicon).
export function Logo({ size = 32, glow = false, class: className = '' }: { size?: number; glow?: boolean; class?: string }) {
  // Per-instance gradient id: the logo renders in both the (hidden on mobile)
  // sidebar and the mobile header, and a url(#id) that resolves into a
  // display:none SVG paints nothing.
  const gid = `obelisk-sfu-logo-${useId()}`
  return (
    <svg
      viewBox="0 0 64 64" width={size} height={size} aria-hidden="true"
      class={`lc-logo flex-shrink-0 ${glow ? 'lc-logo-glow' : ''} ${className}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c5ff6e" />
          <stop offset="1" stop-color="#5a8f1f" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${gid})`} />
      <g fill="none" stroke="#0a0a0a" stroke-width="3.5" stroke-linecap="round">
        <circle cx="32" cy="32" r="10.5" />
        <path d="M24.6 24.6 19 19M39.4 24.6 45 19M24.6 39.4 19 45M39.4 39.4 45 45" />
      </g>
      <g fill="#0a0a0a">
        <circle cx="32" cy="32" r="5" />
        <circle cx="15.5" cy="15.5" r="5" />
        <circle cx="48.5" cy="15.5" r="5" />
        <circle cx="15.5" cy="48.5" r="5" />
        <circle cx="48.5" cy="48.5" r="5" />
      </g>
    </svg>
  )
}
