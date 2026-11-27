import { useMemo } from 'react'

import { BrandMark } from '@/components/layout/brand'

/**
 * Side of the decorative grid, in modules. Real QR codes are 21, 25, 29 …
 * modules a side (21 + 4 × version); 23 is none of them, so no scanner can
 * read this as a QR code. It also carries no format or timing information,
 * no error correction and no payload: it is a picture of the idea of a QR
 * code, drawn from the demo reference so each checkout looks its own.
 */
export const DEMO_QR_MODULES = 23

/** A small deterministic generator, seeded from the reference text. */
function seededBits(seed: string, count: number): boolean[] {
  let h = 2166136261
  for (const ch of seed) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  const bits: boolean[] = []
  for (let i = 0; i < count; i++) {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    bits.push((h >>> 0) % 100 < 46)
  }
  return bits
}

const FINDER = 7

function inFinder(x: number, y: number, n: number): boolean {
  const near = (v: number, start: number) => v >= start && v < start + FINDER + 1
  return (near(x, 0) && near(y, 0)) || (near(x, n - FINDER - 1) && near(y, 0)) || (near(x, 0) && near(y, n - FINDER - 1))
}

function inCentre(x: number, y: number, n: number): boolean {
  const c = (n - 1) / 2
  return Math.abs(x - c) <= 3.5 && Math.abs(y - c) <= 3.5
}

/**
 * A decorative, NON-SCANNABLE QR-style graphic for the demo checkout. Hidden
 * from screen readers apart from one plain description.
 */
export function DemoQrGraphic({ seed, className }: { seed: string; className?: string }) {
  const n = DEMO_QR_MODULES
  const modules = useMemo(() => {
    const bits = seededBits(seed, n * n)
    const cells: { x: number; y: number }[] = []
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (inFinder(x, y, n) || inCentre(x, y, n)) continue
        if (bits[y * n + x]) cells.push({ x, y })
      }
    }
    return cells
  }, [seed, n])

  const finder = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} rx={1.6} fill="currentColor" />
      <rect x={x + 1} y={y + 1} width={5} height={5} rx={1.1} fill="var(--color-surface)" />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.8} fill="currentColor" />
    </g>
  )

  return (
    <div
      className={className}
      role="img"
      aria-label="QR code preview. It cannot be scanned."
      data-testid="demo-qr"
      data-modules={n}
    >
      <div className="relative">
        <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} className="block h-auto w-full text-brand-950" aria-hidden="true">
          <rect x={-1} y={-1} width={n + 2} height={n + 2} rx={2} fill="var(--color-surface)" />
          {modules.map(({ x, y }) => (
            <rect key={`${x}-${y}`} x={x + 0.08} y={y + 0.08} width={0.84} height={0.84} rx={0.22} fill="currentColor" />
          ))}
          {finder(0, 0)}
          {finder(n - 7, 0)}
          {finder(0, n - 7)}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
          <span className="grid size-[22%] place-items-center rounded-[22%] bg-surface p-[2.5%] shadow-[var(--shadow-sm)]">
            <BrandMark className="size-full" />
          </span>
        </div>
      </div>
    </div>
  )
}
