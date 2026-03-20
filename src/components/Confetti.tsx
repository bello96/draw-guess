import { useEffect, useState } from "react";
import { tx } from "@twind/core";

interface FireworkParticle {
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
  rocketDuration: number;
  color: string;
  particles: FireworkParticle[];
}

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

let bid = 0;
let ppid = 0;

function createBurst(x: number, y: number, delay: number): Burst {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  const count = 50 + Math.floor(Math.random() * 30);

  const particles: FireworkParticle[] = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 50 + Math.random() * 140;
    return {
      id: ++ppid,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      color: palette[Math.floor(Math.random() * palette.length)],
      size: 2 + Math.random() * 4,
      duration: 700 + Math.random() * 700,
      sparkle: Math.random() < 0.3,
    };
  });

  return {
    id: ++bid,
    x,
    y,
    delay,
    rocketDuration: 350 + Math.random() * 250,
    color: palette[0],
    particles,
  };
}

export default function Confetti({ duration = 4000 }: { duration?: number }) {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const b: Burst[] = [];

    // Wave 1 — 5 bursts
    for (let i = 0; i < 5; i++) {
      b.push(createBurst(
        12 + Math.random() * 76,
        18 + Math.random() * 30,
        i * 180 + Math.random() * 150,
      ));
    }
    // Wave 2 — 4 bursts
    for (let i = 0; i < 4; i++) {
      b.push(createBurst(
        10 + Math.random() * 80,
        15 + Math.random() * 35,
        900 + i * 200 + Math.random() * 200,
      ));
    }
    // Wave 3 — finale 4 bursts
    for (let i = 0; i < 4; i++) {
      b.push(createBurst(
        15 + Math.random() * 70,
        20 + Math.random() * 25,
        1800 + i * 120 + Math.random() * 120,
      ));
    }

    setBursts(b);
    const t = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(t);
  }, [duration]);

  if (!visible) return null;

  return (
    <div
      className={tx("fixed inset-0 pointer-events-none overflow-hidden")}
      style={{ zIndex: 9999 }}
    >
      {bursts.map((burst) => (
        <div key={burst.id}>
          {/* Rocket trail */}
          <div
            style={{
              position: "absolute",
              left: `${burst.x}%`,
              bottom: 0,
              width: 4,
              height: 20,
              borderRadius: 2,
              background: `linear-gradient(to top, transparent, ${burst.color})`,
              boxShadow: `0 0 8px ${burst.color}, 0 0 16px ${burst.color}`,
              opacity: 0,
              animation: `fw-rocket ${burst.rocketDuration}ms ${burst.delay}ms ease-out forwards`,
              "--ty": `${-(100 - burst.y)}vh`,
            } as React.CSSProperties}
          />

          {/* Flash at burst point */}
          <div
            style={{
              position: "absolute",
              left: `${burst.x}%`,
              top: `${burst.y}%`,
              width: 8,
              height: 8,
              marginLeft: -4,
              marginTop: -4,
              borderRadius: "50%",
              backgroundColor: "#fff",
              boxShadow: `0 0 30px 15px ${burst.color}, 0 0 60px 30px ${burst.color}44`,
              opacity: 0,
              animation: `fw-flash 300ms ${burst.delay + burst.rocketDuration}ms ease-out forwards`,
            }}
          />

          {/* Explosion particles */}
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
                boxShadow: `0 0 ${p.size + 2}px ${p.color}`,
                opacity: 0,
                animation: `fw-explode ${p.duration}ms ${burst.delay + burst.rocketDuration}ms ease-out forwards${p.sparkle ? `, fw-sparkle ${200 + Math.random() * 200}ms ${burst.delay + burst.rocketDuration}ms ease-in-out ${Math.floor(p.duration / 200)}` : ""}`,
                "--dx": `${p.dx}px`,
                "--dy": `${p.dy}px`,
              } as React.CSSProperties}
            />
          ))}
        </div>
      ))}

      <style>{`
        @keyframes fw-rocket {
          0%   { transform: translateY(0); opacity: 0; }
          8%   { opacity: 1; }
          85%  { opacity: 0.9; }
          100% { transform: translateY(var(--ty)); opacity: 0; }
        }
        @keyframes fw-flash {
          0%   { transform: scale(0); opacity: 1; }
          50%  { transform: scale(2.5); opacity: 0.8; }
          100% { transform: scale(4); opacity: 0; }
        }
        @keyframes fw-explode {
          0%   { transform: translate(0, 0) scale(0.3); opacity: 1; }
          15%  { transform: translate(calc(var(--dx) * 0.3), calc(var(--dy) * 0.3)) scale(1.3); opacity: 1; }
          50%  { transform: translate(calc(var(--dx) * 0.75), calc(var(--dy) * 0.75)) scale(1); opacity: 0.85; }
          100% { transform: translate(var(--dx), calc(var(--dy) + 90px)) scale(0.15); opacity: 0; }
        }
        @keyframes fw-sparkle {
          0%, 100% { filter: brightness(1); }
          50%      { filter: brightness(2.5); }
        }
      `}</style>
    </div>
  );
}
