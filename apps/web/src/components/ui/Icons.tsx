export function GemIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36">
      <polygon
        points="18,3 23,13 33,14 26,21 28,32 18,27 8,32 10,21 3,14 13,13"
        fill="#60a5fa"
        opacity={0.85}
      />
      <polygon
        points="18,8 21,14 28,15 23,19 24,27 18,23 12,27 13,19 8,15 15,14"
        fill="#a4c9ff"
      />
    </svg>
  );
}

export function MineIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="10" fill="#f26aff" opacity={0.2} />
      <circle cx="18" cy="18" r="6" fill="#f26aff" opacity={0.35} />
      <path
        d="M11 11l14 14M25 11L11 25"
        stroke="#fda9ff"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line x1="18" y1="3" x2="18" y2="9" stroke="#fda9ff" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="18"
        y1="27"
        x2="18"
        y2="33"
        stroke="#fda9ff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line x1="3" y1="18" x2="9" y2="18" stroke="#fda9ff" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="27"
        y1="18"
        x2="33"
        y2="18"
        stroke="#fda9ff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function HiddenIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36">
      <rect
        x="6"
        y="6"
        width="24"
        height="24"
        rx="4"
        stroke="#a4c9ff"
        strokeWidth="1.5"
        fill="none"
        opacity={0.25}
      />
      <circle cx="18" cy="18" r="4" fill="#a4c9ff" opacity={0.15} />
      <path
        d="M18 10v4M18 22v4M10 18h4M22 18h4"
        stroke="#a4c9ff"
        strokeWidth="1"
        strokeLinecap="round"
        opacity={0.15}
      />
    </svg>
  );
}

export function WinStar({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <polygon
        points="20,2 25,15 39,15 28,23 32,37 20,29 8,37 12,23 1,15 15,15"
        fill="#60a5fa"
        opacity={0.85}
      />
      <polygon
        points="20,8 23,16 32,16 25,21 28,30 20,25 12,30 15,21 8,16 17,16"
        fill="#a4c9ff"
      />
    </svg>
  );
}

export function LoseSkull({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="14" fill="#f26aff" opacity={0.15} />
      <circle cx="20" cy="20" r="8" fill="#f26aff" opacity={0.3} />
      <path
        d="M13 13l14 14M27 13L13 27"
        stroke="#fda9ff"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
