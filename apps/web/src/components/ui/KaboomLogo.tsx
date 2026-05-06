import Image from "next/image";

interface Props {
  /** Square render size in px. Default 36 — fits nav-bar height. */
  size?: number;
  /** Apply a subtle drop-shadow glow under the logo. Useful on light spots. */
  glow?: boolean;
  className?: string;
}

/**
 * Branded "KABOOM!" logo as a transparent PNG. Was previously an SVG
 * placeholder burst — replaced 2026-05-07 with the actual brand mark
 * (background-stripped from the source 400×400 JPG by hand).
 */
export function KaboomLogo({ size = 36, glow = false, className = "" }: Props) {
  return (
    <Image
      src="/kaboom-logo.png"
      alt="Kaboom"
      width={size}
      height={size}
      priority
      className={`${className} ${glow ? "drop-shadow-[0_0_12px_rgba(208,188,255,0.35)]" : ""}`}
    />
  );
}
