interface Props {
  size?: number;
  glow?: boolean;
  className?: string;
}

export function KaboomLogo({ size = 36, glow = false, className = "" }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 400"
      width={size}
      height={size}
      role="img"
      aria-label="Kaboom"
      className={`${className} ${glow ? "drop-shadow-[0_0_12px_rgba(208,188,255,0.35)]" : ""}`}
    >
      <defs>
        <radialGradient id="kb-burst-outer" cx="50%" cy="50%" r="55%">
          <stop offset="55%" stopColor="#fda9ff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#f26aff" stopOpacity="0.85" />
        </radialGradient>
        <radialGradient id="kb-burst-mid" cx="50%" cy="50%" r="50%">
          <stop offset="50%" stopColor="#a4c9ff" stopOpacity="1" />
          <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.95" />
        </radialGradient>
        <radialGradient id="kb-burst-inner" cx="50%" cy="50%" r="45%">
          <stop offset="0%" stopColor="#ecdcff" stopOpacity="1" />
          <stop offset="100%" stopColor="#d0bcff" stopOpacity="0.95" />
        </radialGradient>
        <pattern id="kb-halftone" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="7" cy="7" r="2.2" fill="#d0bcff" fillOpacity="0.55" />
        </pattern>
      </defs>

      <g opacity="0.85">
        <path d="M 0 0 L 96 0 Q 96 96 0 96 Z" fill="url(#kb-halftone)" />
        <path d="M 400 0 L 400 96 Q 304 96 304 0 Z" fill="url(#kb-halftone)" />
        <path d="M 0 400 L 0 304 Q 96 304 96 400 Z" fill="url(#kb-halftone)" />
      </g>

      <g transform="translate(200 200)">
        <polygon
          points="0,-185 38,-78 156,-90 78,-22 175,55 64,55 38,170 0,75 -38,170 -64,55 -175,55 -78,-22 -156,-90 -38,-78"
          fill="url(#kb-burst-outer)"
          stroke="#5e1f8a"
          strokeWidth="3"
          strokeLinejoin="round"
          transform="rotate(8)"
        />
        <polygon
          points="0,-145 30,-58 122,-66 60,-15 138,42 50,42 30,135 0,58 -30,135 -50,42 -138,42 -60,-15 -122,-66 -30,-58"
          fill="url(#kb-burst-mid)"
          stroke="#1b0639"
          strokeWidth="2"
          strokeLinejoin="round"
          transform="rotate(-6)"
        />
        <polygon
          points="0,-100 22,-36 86,-44 40,-8 96,32 36,30 22,90 0,40 -22,90 -36,30 -96,32 -40,-8 -86,-44 -22,-36"
          fill="url(#kb-burst-inner)"
          transform="rotate(2)"
        />
      </g>

      <g transform="translate(200 215)">
        <text
          x="3"
          y="6"
          textAnchor="middle"
          fontFamily="'Space Grotesk', 'Helvetica Neue', Helvetica, 'Arial Black', sans-serif"
          fontWeight="900"
          fontStyle="italic"
          fontSize="78"
          letterSpacing="-3"
          fill="#5e1f8a"
          stroke="#5e1f8a"
          strokeWidth="6"
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          KABOOM!
        </text>
        <text
          x="0"
          y="0"
          textAnchor="middle"
          fontFamily="'Space Grotesk', 'Helvetica Neue', Helvetica, 'Arial Black', sans-serif"
          fontWeight="900"
          fontStyle="italic"
          fontSize="78"
          letterSpacing="-3"
          fill="#ecdcff"
          stroke="#1b0639"
          strokeWidth="3"
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          KABOOM!
        </text>
      </g>
    </svg>
  );
}
