import { Bug } from 'lucide-react';

/** Brand mark: a clean bug glyph on a sage tile. Flat colour only. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--sage-700)" />
      <g transform="translate(6 6)" fill="none" stroke="var(--yellow-300)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6ZM12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
      </g>
    </svg>
  );
}

export type Mood = 'idle' | 'thinking' | 'happy' | 'alert';

/**
 * BUGSY's avatar: a bug glyph in a rounded tile. `mood` only changes the tile colour and adds a calm pulse
 * while BUGSY is working. (Kept under the old name so every call site keeps working.)
 */
export function Mascot({ size = 48, mood = 'idle', className }: { size?: number; mood?: Mood; className?: string }) {
  return (
    <span className={`avatar avatar-${mood} ${className ?? ''}`} style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }} role="img" aria-label="BUGSY, the NO BUGS ALLOWED assistant">
      <Bug size={Math.round(size * 0.52)} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}
