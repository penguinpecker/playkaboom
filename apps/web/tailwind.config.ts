import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#1b0639",
          dim: "#1b0639",
          bright: "#423061",
          container: {
            DEFAULT: "#281546",
            low: "#231041",
            high: "#322051",
            highest: "#3e2b5c",
            lowest: "#160234",
          },
          variant: "#3e2b5c",
        },
        primary: { DEFAULT: "#a4c9ff", container: "#60a5fa" },
        secondary: { DEFAULT: "#d0bcff", container: "#571bc1" },
        tertiary: { DEFAULT: "#fda9ff", container: "#f26aff" },
        error: { DEFAULT: "#ffb4ab", container: "#93000a" },
        "on-primary": "#00315d",
        "on-surface": { DEFAULT: "#ecdcff", variant: "#c1c7d3" },
        outline: { DEFAULT: "#8b919d", variant: "#414751" },
        emerald: "#34d399",
        amber: "#fbbf24",
      },
      fontFamily: {
        headline: ["Space Grotesk", "sans-serif"],
        body: ["Inter", "sans-serif"],
      },
      borderRadius: { DEFAULT: "2px", lg: "4px", xl: "8px", full: "12px" },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(.93)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shake: {
          "0%,100%": { transform: "translateX(0)" },
          "15%,45%,75%": { transform: "translateX(-3px)" },
          "30%,60%,90%": { transform: "translateX(3px)" },
        },
        "pop-in": {
          "0%": { transform: "scale(0) rotate(-8deg)" },
          "60%": { transform: "scale(1.1) rotate(1deg)" },
          "100%": { transform: "scale(1) rotate(0)" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-5px)" },
        },
        "cash-pulse": {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(52,211,153,.4)" },
          "50%": { boxShadow: "0 0 0 8px rgba(52,211,153,0)" },
        },
        "tile-reveal": {
          from: { transform: "scale(.8) rotateY(90deg)", opacity: "0" },
          to: { transform: "scale(1) rotateY(0)", opacity: "1" },
        },
        pulse: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: ".35" },
        },
      },
      animation: {
        "fade-up": "fade-up .35s ease both",
        "scale-in": "scale-in .25s ease both",
        shake: "shake .4s ease",
        "pop-in": "pop-in .3s ease both",
        "slide-down": "slide-down .2s ease both",
        float: "float 3s ease-in-out infinite",
        "cash-pulse": "cash-pulse 1.5s ease infinite",
        "tile-reveal": "tile-reveal .3s ease both",
        pulse: "pulse 2s cubic-bezier(.4,0,.6,1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
