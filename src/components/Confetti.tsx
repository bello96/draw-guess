import { useEffect, useState } from "react";
import { tx } from "@twind/core";

// ============ Confetti (top rain) ============

interface ConfettiPiece {
  id: number;
  left: number;
  delay: number;
  duration: number;
  color: string;
  size: number;
  rotation: number;
  sway: number;
  shape: "circle" | "rect" | "strip";
}

// ============ Firework (bottom launch) ============

interface FwParticle {
  id: number;
  dx: number;
  dy: number;
  color: string;
  size: number;
  duration: number;
  sparkle: boolean;
}

interface Burst {
  id: number;
  x: number;
  y: number;
  delay: number;
  rocketDur: number;
  color: string;
  particles: FwParticle[];
}

const COLORS = [
  "#ff4757", "#ff6b81", "#ffa502", "#ffd32a", "#1e90ff", "#48dbfb",
  "#e056fd", "#f368e0", "#2ed573", "#7bed9f", "#ff6348", "#fab1a0",
  "#a29bfe", "#6c5ce7", "#fdcb6e", "#00cec9", "#fd79a8", "#e84393",
  "#ff9ff3", "#54a0ff", "#00d2d3", "#ee5a24",
];

const PALETTES = [
  ["#ff4757", "#ff6b81", "#ff7979", "#ffcccc"],
  ["#ffa502", "#ffd32a", "#ffdd59", "#fff6a9"],
  ["#1e90ff", "#48dbfb", "#74b9ff", "#dfe6e9"],
  ["#e056fd", "#f368e0", "#fd79a8", "#ffeaa7"],
  ["#2ed573", "#7bed9f", "#55efc4", "#00d2d3"],
  ["#ff6348", "#ff7675", "#fab1a0", "#ffeaa7"],
  ["#a29bfe", "#6c5ce7", "#9b59b6", "#dfe6e9"],
  ["#fdcb6e", "#f39c12", "#e17055", "#ff7675"],
  ["#00cec9", "#81ecec", "#55efc4", "#dfe6e9"],
  ["#fd79a8", "#e84393", "#d63031", "#ffcccc"],
];

let uid = 0;

function pickColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function createConfetti(count: number): ConfettiPiece[] {
  const shapes: ConfettiPiece["shape"][] = ["circle", "rect", "strip"];
  return Array.from({ length: count }, () => {
    // Weighted delay: most pieces launch early, fewer launch late → natural thinning
    const r = Math.random();
    const delay = r * r * 4500; // quadratic: dense at start, sparse at end
    return {
      id: ++uid,
      left: Math.random() * 100,
      delay,
      duration: 2500 + Math.random() * 2500,
      color: pickColor(),
      size: 6 + Math.random() * 8,
      rotation: Math.random() * 360,
      sway: -60 + Math.random() * 120,
      shape: shapes[Math.floor(Math.random() * shapes.length)],
    };
  });
}

function createBurst(x: number, y: number, delay: number): Burst {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  const count = 60 + Math.floor(Math.random() * 40);

  const particles: FwParticle[] = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 160;
    return {
      id: ++uid,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      color: palette[Math.floor(Math.random() * palette.length)],
      size: 2.5 + Math.random() * 4.5,
      duration: 800 + Math.random() * 800,
      sparkle: Math.random() < 0.35,
    };
  });

  return {
    id: ++uid,
    x,
    y,
    delay,
    rocketDur: 300 + Math.random() * 250,
    color: palette[0],
    particles,
  };
}

export default function Confetti() {
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // --- Confetti rain from top: 150 pieces ---
    const cf = createConfetti(150);
    setConfetti(cf);

    // --- Fireworks from bottom: 16 bursts in 3 waves ---
    const b: Burst[] = [];
    for (let i = 0; i < 6; i++) {
      b.push(createBurst(8 + Math.random() * 84, 15 + Math.random() * 30, i * 160 + Math.random() * 120));
    }
    for (let i = 0; i < 5; i++) {
      b.push(createBurst(5 + Math.random() * 90, 12 + Math.random() * 35, 800 + i * 180 + Math.random() * 150));
    }
    for (let i = 0; i < 5; i++) {
      b.push(createBurst(10 + Math.random() * 80, 18 + Math.random() * 28, 1700 + i * 100 + Math.random() * 100));
    }
    setBursts(b);

    // Calculate when ALL animations finish so we don't cut them off
    const cfEnd = Math.max(...cf.map((p) => p.delay + p.duration));
    const fwEnd = Math.max(...b.map((burst) =>
      burst.delay + burst.rocketDur + Math.max(...burst.particles.map((p) => p.duration)),
    ));
    const totalDuration = Math.max(cfEnd, fwEnd) + 300; // 300ms buffer

    const t = setTimeout(() => setVisible(false), totalDuration);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div
      className={tx("fixed inset-0 pointer-events-none overflow-hidden")}
      style={{ zIndex: 9999 }}
    >
      {/* ====== Confetti rain from top ====== */}
      {confetti.map((p) => {
        const w = p.shape === "strip" ? p.size * 0.35 : p.size;
        const h = p.shape === "rect" ? p.size * 0.6 : p.shape === "strip" ? p.size * 1.8 : p.size;
        const br = p.shape === "circle" ? "50%" : "2px";
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: `${p.left}%`,
              top: -20,
              width: w,
              height: h,
              backgroundColor: p.color,
              borderRadius: br,
              opacity: 0,
              animation: `cf-fall ${p.duration}ms ${p.delay}ms ease-in forwards`,
              "--sway": `${p.sway}px`,
              "--rot": `${p.rotation}deg`,
            } as React.CSSProperties}
          />
        );
      })}

      {/* ====== Fireworks from bottom ====== */}
      {bursts.map((burst) => (
        <div key={burst.id}>
          {/* Rocket */}
          <div
            style={{
              position: "absolute",
              left: `${burst.x}%`,
              bottom: 0,
              width: 4,
              height: 24,
              borderRadius: 2,
              background: `linear-gradient(to top, transparent, ${burst.color})`,
              boxShadow: `0 0 10px ${burst.color}, 0 0 20px ${burst.color}`,
              opacity: 0,
              animation: `fw-rocket ${burst.rocketDur}ms ${burst.delay}ms ease-out forwards`,
              "--ty": `${-(100 - burst.y)}vh`,
            } as React.CSSProperties}
          />

          {/* Flash */}
          <div
            style={{
              position: "absolute",
              left: `${burst.x}%`,
              top: `${burst.y}%`,
              width: 10,
              height: 10,
              marginLeft: -5,
              marginTop: -5,
              borderRadius: "50%",
              backgroundColor: "#fff",
              boxShadow: `0 0 40px 20px ${burst.color}, 0 0 80px 40px ${burst.color}66`,
              opacity: 0,
              animation: `fw-flash 350ms ${burst.delay + burst.rocketDur}ms ease-out forwards`,
            }}
          />

          {/* Particles */}
          {burst.particles.map((p) => (
            <div
              key={p.id}
              style={{
                position: "absolute",
                left: `${burst.x}%`,
                top: `${burst.y}%`,
                width: p.size,
                height: p.size,
                borderRadius: "50%",
                backgroundColor: p.color,
                boxShadow: `0 0 ${p.size + 3}px ${p.color}`,
                opacity: 0,
                animation: `fw-explode ${p.duration}ms ${burst.delay + burst.rocketDur}ms ease-out forwards${p.sparkle ? `, fw-sparkle ${150 + Math.random() * 150}ms ${burst.delay + burst.rocketDur}ms ease-in-out ${Math.floor(p.duration / 150)}` : ""}`,
                "--dx": `${p.dx}px`,
                "--dy": `${p.dy}px`,
              } as React.CSSProperties}
            />
          ))}
        </div>
      ))}

      <style>{`
        @keyframes cf-fall {
          0%   { transform: translateY(0) translateX(0) rotate(0deg) scale(1); opacity: 1; }
          25%  { opacity: 1; }
          50%  { transform: translateY(50vh) translateX(var(--sway)) rotate(var(--rot)) scale(0.9); opacity: 0.9; }
          100% { transform: translateY(105vh) translateX(calc(var(--sway) * -0.5)) rotate(calc(var(--rot) + 360deg)) scale(0.4); opacity: 0; }
        }
        @keyframes fw-rocket {
          0%   { transform: translateY(0); opacity: 0; }
          8%   { opacity: 1; }
          80%  { opacity: 0.9; }
          100% { transform: translateY(var(--ty)); opacity: 0; }
        }
        @keyframes fw-flash {
          0%   { transform: scale(0); opacity: 1; }
          40%  { transform: scale(3); opacity: 0.9; }
          100% { transform: scale(5); opacity: 0; }
        }
        @keyframes fw-explode {
          0%   { transform: translate(0, 0) scale(0.3); opacity: 1; }
          12%  { transform: translate(calc(var(--dx) * 0.25), calc(var(--dy) * 0.25)) scale(1.4); opacity: 1; }
          45%  { transform: translate(calc(var(--dx) * 0.7), calc(var(--dy) * 0.7)) scale(1); opacity: 0.85; }
          100% { transform: translate(var(--dx), calc(var(--dy) + 100px)) scale(0.1); opacity: 0; }
        }
        @keyframes fw-sparkle {
          0%, 100% { filter: brightness(1); }
          50%      { filter: brightness(3); }
        }
      `}</style>
    </div>
  );
}
