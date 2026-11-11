import { motion } from 'framer-motion';

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#687B58" />
      <path d="M27 12 22 5M37 12l5-7" stroke="#F6D96B" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="32" cy="38" rx="14" ry="16" fill="#F5F0E4" />
      <circle cx="32" cy="20" r="9" fill="#F5F0E4" />
      <circle cx="28" cy="19" r="2.4" fill="#2B3228" />
      <circle cx="36" cy="19" r="2.4" fill="#2B3228" />
      <path d="M32 27v23" stroke="#687B58" strokeWidth="2.5" />
    </svg>
  );
}

export type Mood = 'idle' | 'thinking' | 'happy' | 'alert';

/** BUGSY: a flat, friendly bug. Blinks on its own, wiggles when thinking. No gradients. */
export function Mascot({ size = 64, mood = 'idle', className }: { size?: number; mood?: Mood; className?: string }) {
  const eyeY = mood === 'thinking' ? -1.5 : 0;
  return (
    <motion.svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="BUGSY, the NO BUGS ALLOWED assistant"
      animate={mood === 'thinking' ? { rotate: [-4, 4, -4] } : mood === 'happy' ? { y: [0, -6, 0] } : { y: [0, -2, 0] }}
      transition={{ duration: mood === 'thinking' ? 0.7 : mood === 'happy' ? 0.5 : 3.2, repeat: Infinity, ease: 'easeInOut' }}
    >
      {/* legs */}
      <g stroke="#3F4E37" strokeWidth="4" strokeLinecap="round" fill="none">
        <path d="M24 54 10 50M24 64 8 66M26 74 14 84" />
        <path d="M72 54 86 50M72 64 88 66M70 74 82 84" />
      </g>
      {/* antennae */}
      <g stroke="#3F4E37" strokeWidth="3.5" strokeLinecap="round" fill="none">
        <path d="M38 22 30 8" />
        <path d="M58 22 66 8" />
      </g>
      <circle cx="30" cy="7" r="5.5" fill="#EFD878" stroke="#3F4E37" strokeWidth="3" />
      <circle cx="66" cy="7" r="5.5" fill="#EFD878" stroke="#3F4E37" strokeWidth="3" />
      {/* body */}
      <ellipse cx="48" cy="62" rx="28" ry="26" fill="#687B58" stroke="#3F4E37" strokeWidth="4" />
      <ellipse cx="48" cy="68" rx="17" ry="16" fill="#F6EDC8" />
      <path d="M48 46v46" stroke="#3F4E37" strokeWidth="3" opacity="0.35" />
      {/* head */}
      <circle cx="48" cy="34" r="20" fill="#F5F0E4" stroke="#3F4E37" strokeWidth="4" />
      {/* eyes */}
      <g className="bugsy-eyes" style={{ transformOrigin: '48px 34px' }}>
        <circle cx="40" cy={34 + eyeY} r={mood === 'alert' ? 6 : 4.6} fill="#2B3228" />
        <circle cx="56" cy={34 + eyeY} r={mood === 'alert' ? 6 : 4.6} fill="#2B3228" />
        <circle cx="41.6" cy={32.4 + eyeY} r="1.4" fill="#F5F0E4" />
        <circle cx="57.6" cy={32.4 + eyeY} r="1.4" fill="#F5F0E4" />
      </g>
      {/* mouth */}
      {mood === 'happy' ? (
        <path d="M41 43q7 8 14 0" stroke="#2B3228" strokeWidth="3" strokeLinecap="round" fill="#EFD878" />
      ) : mood === 'alert' ? (
        <ellipse cx="48" cy="45" rx="3.4" ry="4" fill="#2B3228" />
      ) : (
        <path d="M42 43q6 5 12 0" stroke="#2B3228" strokeWidth="3" strokeLinecap="round" fill="none" />
      )}
      {/* cheeks */}
      <circle cx="33" cy="42" r="3.2" fill="#EFD878" />
      <circle cx="63" cy="42" r="3.2" fill="#EFD878" />
    </motion.svg>
  );
}
