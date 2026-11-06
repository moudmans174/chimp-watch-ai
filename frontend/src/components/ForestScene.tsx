/* Original layered rainforest illustration: misty ridges, canopy, and a chimpanzee family resting on a branch.
   Pure SVG, no external assets, so it works offline in the PWA. */
import { useMemo } from "react";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** A row of tree crowns along a baseline: clusters of circles read as rainforest canopy. */
function canopy(seed: number, y: number, width: number, minR: number, maxR: number, jitter: number) {
  const r = rng(seed);
  const crowns: { cx: number; cy: number; r: number }[] = [];
  let x = -40;
  while (x < width + 40) {
    const rad = minR + r() * (maxR - minR);
    const top = y - rad * (0.6 + r() * jitter);
    crowns.push({ cx: x, cy: top, r: rad });
    if (r() > 0.45) crowns.push({ cx: x + rad * 0.55, cy: top - rad * 0.35, r: rad * 0.7 });
    if (r() > 0.75) crowns.push({ cx: x + rad * 0.2, cy: top - rad * 0.9, r: rad * 0.45 }); // emergent tree
    x += rad * (1.1 + r() * 0.6);
  }
  return crowns;
}

function Chimp({ x, y, s = 1, flip = false }: { x: number; y: number; s?: number; flip?: boolean }) {
  // Seated chimpanzee in profile: rounded back, head with brow ridge and muzzle, long resting arm.
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`}>
      <path d="M-14 0 C-24 -6 -26 -30 -14 -42 C-6 -50 8 -50 14 -40 C20 -30 20 -12 16 0 Z" />
      <path d="M2 -46 C0 -58 8 -66 17 -64 C24 -63 28 -58 28 -52 L33 -49 C35 -47 34 -43 30 -42 C27 -38 22 -37 18 -39 C12 -38 6 -40 2 -46 Z" />
      <path d="M10 -34 C18 -30 22 -18 24 -4 C24 0 20 1 18 -2 C16 -12 12 -22 6 -28 Z" />
      <ellipse cx="-4" cy="0" rx="18" ry="5" />
    </g>
  );
}

export default function ForestScene({ variant = "hero", className = "" }: { variant?: "hero" | "panel" | "band" | "rail"; className?: string }) {
  const W = 1440, H = variant === "hero" ? 560 : 420;
  const layers = useMemo(() => ({
    far: canopy(11, H * 0.62, W, 26, 46, 0.5),
    mid: canopy(23, H * 0.76, W, 34, 62, 0.7),
    near: canopy(37, H * 0.92, W, 44, 86, 0.6),
  }), [H]);
  const showChimps = variant === "hero" || variant === "panel";
  return (
    <svg className={`forest-scene fs-${variant} ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={variant === "panel" ? "xMaxYMax slice" : "xMidYMax slice"} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`sky-${variant}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d211a" />
          <stop offset="0.55" stopColor="#1d3a2e" />
          <stop offset="1" stopColor="#3f6450" />
        </linearGradient>
        <radialGradient id={`sun-${variant}`} cx="0.76" cy="0.42" r="0.42">
          <stop offset="0" stopColor="#f2d58a" stopOpacity="0.5" />
          <stop offset="0.5" stopColor="#c9b26a" stopOpacity="0.1" />
          <stop offset="1" stopColor="#c9b26a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`mist-${variant}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9c3ad" stopOpacity="0" />
          <stop offset="0.5" stopColor="#a9c3ad" stopOpacity="0.22" />
          <stop offset="1" stopColor="#a9c3ad" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#sky-${variant})`} />
      <rect width={W} height={H} fill={`url(#sun-${variant})`} />
      {/* distant mountain ridge */}
      <path fill="#36584a" opacity="0.7"
        d={`M0 ${H * 0.55} C180 ${H * 0.42} 300 ${H * 0.5} 420 ${H * 0.44} S700 ${H * 0.3} 860 ${H * 0.4} S1180 ${H * 0.36} 1300 ${H * 0.45} L${W} ${H * 0.42} L${W} ${H} L0 ${H} Z`} />
      <g fill="#2b4a3d">{layers.far.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />)}<rect y={H * 0.62} width={W} height={H} /></g>
      <rect y={H * 0.5} width={W} height={H * 0.25} fill={`url(#mist-${variant})`} />
      <g fill="#1f3a2f">{layers.mid.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />)}<rect y={H * 0.76} width={W} height={H} /></g>
      <g fill="#132a21">{layers.near.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />)}<rect y={H * 0.92} width={W} height={H} /></g>
      {showChimps && (
        <g fill="#0b1c16">
          {/* emergent tree on the right: trunk, crown and a long branch with a mother and juvenile */}
          <path d={`M${W - 92} ${H} C${W - 88} ${H * 0.75} ${W - 84} ${H * 0.5} ${W - 78} ${H * 0.26} L${W - 48} ${H * 0.26} C${W - 50} ${H * 0.5} ${W - 46} ${H * 0.75} ${W - 40} ${H} Z`} />
          <circle cx={W - 64} cy={H * 0.2} r={78} /><circle cx={W - 150} cy={H * 0.24} r={56} /><circle cx={W + 10} cy={H * 0.24} r={64} />
          <circle cx={W - 100} cy={H * 0.12} r={52} /><circle cx={W - 20} cy={H * 0.1} r={48} />
          <path d={`M${W - 84} ${H * 0.56} C${W - 180} ${H * 0.555} ${W - 300} ${H * 0.565} ${W - 430} ${H * 0.585} C${W - 470} ${H * 0.592} ${W - 500} ${H * 0.585} ${W - 520} ${H * 0.575} L${W - 518} ${H * 0.588} C${W - 470} ${H * 0.606} ${W - 300} ${H * 0.592} ${W - 84} ${H * 0.582} Z`} />
          <Chimp x={W - 300} y={H * 0.566} s={1.3} flip />
          <Chimp x={W - 222} y={H * 0.562} s={0.78} flip />
          {/* hornbills crossing the valley */}
          <path d={`M${W * 0.38} ${H * 0.22} q10 -8 20 0 q10 -8 20 0`} stroke="#0b1c16" strokeWidth="2.4" fill="none" />
          <path d={`M${W * 0.42} ${H * 0.18} q7 -6 14 0 q7 -6 14 0`} stroke="#0b1c16" strokeWidth="2" fill="none" />
        </g>
      )}
    </svg>
  );
}
