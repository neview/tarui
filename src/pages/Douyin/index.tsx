import { useState, useRef, useCallback } from "react"
import BottomNav from "./BottomNav"
import GenieTransition from "./GenieTransition"
import {
  HomePage,
  BookmarkPage,
  PublishPage,
  ProfilePage,
  SettingsPage,
} from "./panels"

const panels = [HomePage, BookmarkPage, PublishPage, ProfilePage, SettingsPage]

export default function Douyin() {
  const [displayPanel, setDisplayPanel] = useState(0)
  const [targetPanel, setTargetPanel] = useState(0)
  const [animState, setAnimState] = useState<"idle" | "exiting" | "entering">("idle")
  const [sinkX, setSinkX] = useState(50)
  const contentRef = useRef<HTMLDivElement>(null)

  const handleNavChange = useCallback(
    (index: number, iconCenterX: number) => {
      if (index === displayPanel || animState !== "idle") return

      const el = contentRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        const pct = ((iconCenterX - rect.left) / rect.width) * 100
        setSinkX(Math.max(0, Math.min(100, pct)))
      }

      setTargetPanel(index)
      setAnimState("exiting")
    },
    [displayPanel, animState],
  )

  const handleAnimComplete = useCallback(() => {
    if (animState === "exiting") {
      setDisplayPanel(targetPanel)
      setAnimState("entering")
    } else if (animState === "entering") {
      setAnimState("idle")
    }
  }, [animState, targetPanel])

  const activeTab = animState === "idle" ? displayPanel : targetPanel
  const Panel = panels[displayPanel]

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div ref={contentRef} className="absolute inset-0">
        <GenieTransition
          state={animState}
          sinkXPercent={sinkX}
          onComplete={handleAnimComplete}
        >
          <Panel />
        </GenieTransition>
      </div>
      <BottomNav active={activeTab} onChange={handleNavChange} />
    </div>
  )
}
