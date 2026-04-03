import { useState, useRef, useLayoutEffect, useCallback } from "react"
import { motion } from "motion/react"
import { Home, Bookmark, CirclePlus, UserRound, Settings } from "lucide-react"

const navItems = [
  { icon: Home, label: "首页" },
  { icon: Bookmark, label: "收藏" },
  { icon: CirclePlus, label: "发布" },
  { icon: UserRound, label: "我的" },
  { icon: Settings, label: "设置" },
]

interface BottomNavProps {
  active: number
  onChange: (index: number, iconCenterX: number) => void
}

export default function BottomNav({ active, onChange }: BottomNavProps) {
  const navRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [spotX, setSpotX] = useState<number | null>(null)
  const isFirstRenderRef = useRef(true)

  const measure = useCallback(() => {
    const btn = itemRefs.current[active]
    const nav = navRef.current
    if (btn && nav) {
      const btnRect = btn.getBoundingClientRect()
      const navRect = nav.getBoundingClientRect()
      setSpotX(btnRect.left - navRect.left + btnRect.width / 2)
    }
  }, [active])

  useLayoutEffect(() => {
    measure()
    if (isFirstRenderRef.current) {
      requestAnimationFrame(() => {
        isFirstRenderRef.current = false
      })
    }
  }, [measure])

  const handleClick = (index: number) => {
    const btn = itemRefs.current[index]
    if (btn) {
      const rect = btn.getBoundingClientRect()
      onChange(index, rect.left + rect.width / 2)
    } else {
      onChange(index, window.innerWidth / 2)
    }
  }

  return (
    <>
      {/* Bottom gradient backdrop */}
      <div
        className="absolute bottom-0 left-0 right-0 z-40 pointer-events-none"
        style={{
          height: 100,
          background: "linear-gradient(to top, rgba(5,5,16,0.85) 0%, rgba(5,5,16,0.5) 40%, rgba(5,5,16,0) 100%)",
          backdropFilter: "blur(12px) saturate(1.2)",
          WebkitBackdropFilter: "blur(12px) saturate(1.2)",
          maskImage: "linear-gradient(to top, black 0%, black 50%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to top, black 0%, black 50%, transparent 100%)",
        }}
      />

    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-50">
      <nav
        ref={navRef}
        className="relative flex items-center"
        style={{
          gap: 8,
          padding: "9px 24px",
          borderRadius: 20,
          background: "rgba(10, 10, 20, 0.45)",
          backdropFilter: "blur(30px) saturate(1.3)",
          WebkitBackdropFilter: "blur(30px) saturate(1.3)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        {/* 聚光灯指示器 */}
        {spotX !== null && (
          <motion.div
            className="absolute top-0 pointer-events-none"
            initial={false}
            animate={{ left: spotX }}
            transition={
              isFirstRenderRef.current
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 30, mass: 0.8 }
            }
            style={{ width: 0, height: "100%" }}
          >
            {/* 顶部发光横条 */}
            <div
              className="absolute -translate-x-1/2"
              style={{
                top: -1,
                left: 0,
                width: 44,
                height: 5,
                borderRadius: 4,
                background: "rgba(255,255,255,0.95)",
                boxShadow:
                  "0 0 12px 4px rgba(255,255,255,0.4), 0 0 4px 1px rgba(255,255,255,0.7)",
              }}
            />

            {/* 梯形聚光灯光束 */}
            <div
              className="absolute -translate-x-1/2"
              style={{
                top: 0,
                left: 0,
                width: 84,
                height: "calc(100% + 16px)",
                clipPath: "polygon(30% 0%, 70% 0%, 92% 100%, 8% 100%)",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.02) 100%)",
              }}
            />

            {/* 底部椭圆光斑 */}
            <div
              className="absolute -translate-x-1/2"
              style={{
                bottom: -6,
                left: 0,
                width: 80,
                height: 28,
                borderRadius: "50%",
                background:
                  "radial-gradient(ellipse, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.12) 50%, transparent 100%)",
                filter: "blur(6px)",
              }}
            />
          </motion.div>
        )}

        {/* 导航按钮 */}
        {navItems.map((item, index) => {
          const Icon = item.icon
          const isActive = active === index
          return (
            <motion.button
              key={item.label}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              className="relative z-10 flex items-center justify-center cursor-pointer"
              style={{
                width: 44,
                height: 38,
                background: "transparent",
                border: "none",
                outline: "none",
                WebkitTapHighlightColor: "transparent",
              }}
              animate={{ scale: isActive ? 1.1 : 1 }}
              transition={{ type: "spring", stiffness: 600, damping: 8, mass: 0.5 }}
              onClick={() => handleClick(index)}
            >
              <Icon
                size={22}
                strokeWidth={isActive ? 2 : 1.5}
                style={{
                  color: isActive ? "#ffffff" : "rgba(255,255,255,0.3)",
                  filter: isActive
                    ? "drop-shadow(0 0 6px rgba(255,255,255,0.35))"
                    : "none",
                  transition: "color 0.3s ease, filter 0.3s ease, stroke-width 0.3s ease",
                }}
              />
              {isActive && (
                <div
                  className="absolute"
                  style={{
                    bottom: -1,
                    width: 22,
                    height: 8,
                    borderRadius: "50%",
                    background: "rgba(255,255,255,0.45)",
                    filter: "blur(5px)",
                    transform: "translateX(-50%) perspective(40px) rotateX(30deg)",
                    left: "50%",
                  }}
                />
              )}
            </motion.button>
          )
        })}
      </nav>
    </div>
    </>
  )
}
