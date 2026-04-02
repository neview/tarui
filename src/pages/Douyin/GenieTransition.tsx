import { useRef, useEffect, type ReactNode } from "react"
import { motion } from "motion/react"

const SLICES = 14
const EXIT_MAX_STAGGER = 0.16
const EXIT_DURATION = 0.36
const ENTER_MAX_STAGGER = 0.16
const ENTER_DURATION = 0.36

interface GenieTransitionProps {
  children: ReactNode
  state: "idle" | "exiting" | "entering"
  sinkXPercent: number
  onComplete: () => void
}

export default function GenieTransition({
  children,
  state,
  sinkXPercent,
  onComplete,
}: GenieTransitionProps) {
  const firedRef = useRef(false)

  useEffect(() => {
    firedRef.current = false
  }, [state])

  if (state === "idle") {
    return <div className="h-full w-full">{children}</div>
  }

  const isExit = state === "exiting"

  const handleDone = () => {
    if (!firedRef.current) {
      firedRef.current = true
      onComplete()
    }
  }

  return (
    <div className="h-full w-full relative">
      {Array.from({ length: SLICES }, (_, i) => {
        const topPct = (i / SLICES) * 100
        const btmPct = ((i + 1) / SLICES) * 100
        const progress = i / (SLICES - 1)

        const clipTop = Math.max(0, topPct - 0.5)
        const clipBtm = Math.max(0, 100 - btmPct - 0.5)

        const travelY = ((SLICES - i - 0.5) / SLICES) * 100
        const distFromSink = 1 - progress

        const delay = isExit
          ? EXIT_MAX_STAGGER * Math.pow(distFromSink, 1.7)
          : ENTER_MAX_STAGGER * Math.pow(progress, 1.7)

        const duration = isExit ? EXIT_DURATION : ENTER_DURATION

        const exitP1 = 0.42 + progress * 0.28
        const exitP4 = 0.42 - progress * 0.30
        const exitEase: [number, number, number, number] = [exitP1, 0, 1, exitP4]

        const enterP2 = 1 - exitP4
        const enterP3 = 1 - exitP1
        const enterEase: [number, number, number, number] = [0, enterP2, enterP3, 1]

        const collapsed = {
          y: `${travelY}%`,
          scaleX: 0.015,
          opacity: 0,
          filter: "blur(2.5px)",
        }

        const expanded = {
          y: "0%",
          scaleX: 1,
          opacity: 1,
          filter: "blur(0px)",
        }

        const isLast = isExit ? i === 0 : i === SLICES - 1

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
            {children}
          </motion.div>
        )
      })}
    </div>
  )
}
