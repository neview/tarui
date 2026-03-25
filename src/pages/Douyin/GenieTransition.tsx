import { useRef, useEffect, type ReactNode } from "react";
import { motion } from "motion/react";

const SLICES = 14;
const EXIT_MAX_STAGGER = 0.16;
const EXIT_DURATION = 0.36;
const ENTER_MAX_STAGGER = 0.16;
const ENTER_DURATION = 0.36;

interface GenieTransitionProps {
  children: ReactNode;
  state: "idle" | "exiting" | "entering";
  sinkXPercent: number;
  onComplete: () => void;
}

export default function GenieTransition({
  children,
  state,
  sinkXPercent,
  onComplete,
}: GenieTransitionProps) {
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
  }, [state]);

  if (state === "idle") {
    return <div className="h-full w-full">{children}</div>;
  }

  const isExit = state === "exiting";

  const handleDone = () => {
    if (!firedRef.current) {
      firedRef.current = true;
      onComplete();
    }
  };

  return (
    <div className="h-full w-full relative">
      {Array.from({ length: SLICES }, (_, i) => {
        const topPct = (i / SLICES) * 100;
        const btmPct = ((i + 1) / SLICES) * 100;
        const progress = i / (SLICES - 1); // 0 = top, 1 = bottom

        // slight overlap to eliminate hairline gaps between slices
        const clipTop = Math.max(0, topPct - 0.5);
        const clipBtm = Math.max(0, 100 - btmPct - 0.5);

        const travelY = ((SLICES - i - 0.5) / SLICES) * 100;

        const distFromSink = 1 - progress; // 1=top, 0=bottom

        // --- EXIT: bottom slices first ---
        // --- ENTER: top slices first (exact reverse) ---
        const delay = isExit
          ? EXIT_MAX_STAGGER * Math.pow(distFromSink, 1.7)
          : ENTER_MAX_STAGGER * Math.pow(progress, 1.7);

        const duration = isExit ? EXIT_DURATION : ENTER_DURATION;

        // exit easing per slice (ease-in: accelerating suction)
        const exitP1 = 0.42 + progress * 0.28;
        const exitP4 = 0.42 - progress * 0.30;
        const exitEase: [number, number, number, number] = [exitP1, 0, 1, exitP4];

        // enter easing: exact reverse of exit easing
        // reverse of [a, b, c, d] = [1-c, 1-d, 1-a, 1-b]
        const enterP1 = 1 - 1;            // 0
        const enterP2 = 1 - exitP4;       // mirrors exit end
        const enterP3 = 1 - exitP1;       // mirrors exit start
        const enterP4 = 1;                // 1
        const enterEase: [number, number, number, number] = [enterP1, enterP2, enterP3, enterP4];

        const collapsed = {
          y: `${travelY}%`,
          scaleX: 0.015,
          opacity: 0,
          filter: "blur(2.5px)",
        };

        const expanded = {
          y: "0%",
          scaleX: 1,
          opacity: 1,
          filter: "blur(0px)",
        };

        // for exit: slice 0 (top) has longest delay → finishes last
        // for enter: slice N-1 (bottom) has longest delay → finishes last
        const isLast = isExit ? i === 0 : i === SLICES - 1;

        return (
          <motion.div
            key={i}
            className="absolute inset-0"
            style={{
              clipPath: `inset(${clipTop}% 0% ${clipBtm}% 0%)`,
              transformOrigin: `${sinkXPercent}% 100%`,
              willChange: "transform, opacity, filter",
            }}
            initial={isExit ? expanded : collapsed}
            animate={isExit ? collapsed : expanded}
            transition={{
              delay,
              duration,
              ease: isExit ? exitEase : enterEase,
            }}
            onAnimationComplete={isLast ? handleDone : undefined}
          >
            {/* 骨架屏遮罩 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden bg-[#111]">
              <div className="p-5 space-y-4">
                {/* 标题骨架 */}
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded bg-white/[0.06]" />
                  <div className="w-20 h-5 rounded bg-white/[0.06]" />
                </div>
                {/* 卡片骨架 */}
                <div className="grid grid-cols-2 gap-3">
                  {[0, 1, 2, 3].map((n) => (
                    <div key={n} className="rounded-2xl aspect-[4/3] bg-white/[0.06]" />
                  ))}
                </div>
                {/* 列表骨架 */}
                <div className="rounded-2xl p-4 bg-white/[0.06] space-y-3">
                  <div className="w-24 h-4 rounded bg-white/[0.04]" />
                  <div className="w-full h-3 rounded bg-white/[0.04]" />
                  <div className="w-3/4 h-3 rounded bg-white/[0.04]" />
                  <div className="w-5/6 h-3 rounded bg-white/[0.04]" />
                </div>
              </div>
              {/* shimmer 光效 */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 60%, transparent 100%)",
                  backgroundSize: "200% 100%",
                  animation: "skeleton-shimmer 1.5s ease-in-out infinite",
                }}
              />
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
