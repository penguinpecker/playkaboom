export function KaboomLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <polygon
        points="50,8 56,26 68,12 65,30 82,22 74,38 92,36 80,48 96,50 80,52 92,64 74,62 82,78 65,70 68,88 56,74 50,92 44,74 32,88 35,70 18,78 26,62 8,64 20,52 4,50 20,48 8,36 26,38 18,22 35,30 32,12 44,26"
        fill="#1a3a7a"
        stroke="#60a5fa"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="52" r="28" fill="#06060e" stroke="#1e3a6e" strokeWidth="1.5" />
      <ellipse
        cx="40"
        cy="41"
        rx="8"
        ry="5"
        fill="#a4c9ff"
        opacity="0.18"
        transform="rotate(-30,40,41)"
      />
      <ellipse cx="57" cy="26" rx="4" ry="3" fill="#0c1025" stroke="#60a5fa" strokeWidth="1.5" />
      <path
        d="M 58 25 Q 72 18 80 10"
        fill="none"
        stroke="#6a420e"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M 58 25 Q 72 18 80 10"
        fill="none"
        stroke="#c9a43a"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path d="M 80,13 C 74,6 73,0 80,0 C 87,0 86,6 80,13 Z" fill="#7e22ce" />
      <path d="M 80,12 C 75,6 74,1 80,2 C 86,1 85,6 80,12 Z" fill="#f26aff" />
      <path d="M 80,10 C 76,5 76,2 80,3 C 84,2 84,5 80,10 Z" fill="#f0abfc" />
      <ellipse cx="80" cy="6" rx="2.5" ry="4" fill="#fce7ff" />
      <ellipse cx="80" cy="4.5" rx="1.5" ry="2.5" fill="white" />
    </svg>
  );
}
