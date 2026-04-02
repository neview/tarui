import { useState, useCallback, useRef, useEffect } from "react"
import { motion, AnimatePresence } from "motion/react"
import { DottedMap } from "@/components/ui/dotted-map"
import type { Marker } from "@/components/ui/dotted-map"
import { X } from "lucide-react"

const markers: Marker[] = [
  { lat: 37.5665, lng: 126.978, size: 0.3 },
  { lat: 40.7128, lng: -74.006, size: 0.3, pulse: false },
]

interface ImageItem {
  id: string
  src: string
  title: string
  author: string
  height: number
  ratio: number
}

const DEMO_IMAGES: ImageItem[] = [
  {
    id: "1",
    src: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=400&q=80",
    title: "Mountain Lake",
    author: "Bailey Zindel",
    height: 280,
    ratio: 3 / 2,
  },
  {
    id: "2",
    src: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=400&q=80",
    title: "Starry Mountains",
    author: "Benjamin Voros",
    height: 200,
    ratio: 3 / 2,
  },
  {
    id: "3",
    src: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=400&q=80",
    title: "Foggy Forest",
    author: "v2osk",
    height: 240,
    ratio: 3 / 2,
  },
  {
    id: "4",
    src: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400&q=80",
    title: "Green Canopy",
    author: "Luca Bravo",
    height: 320,
    ratio: 3 / 2,
  },
  {
    id: "5",
    src: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80",
    title: "Tropical Beach",
    author: "Sean O.",
    height: 190,
    ratio: 3 / 2,
  },
  {
    id: "6",
    src: "https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=400&q=80",
    title: "Golden Fields",
    author: "Robert Lukeman",
    height: 260,
    ratio: 3 / 2,
  },
  {
    id: "7",
    src: "https://images.unsplash.com/photo-1465056836900-8f1e940f2114?w=400&q=80",
    title: "Autumn Path",
    author: "Patrick Tomasso",
    height: 300,
    ratio: 3 / 2,
  },
  {
    id: "8",
    src: "https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=400&q=80",
    title: "Waterfall Bridge",
    author: "Josh Hild",
    height: 220,
    ratio: 3 / 2,
  },
  {
    id: "9",
    src: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=400&q=80",
    title: "Lake Reflection",
    author: "Pietro De Grandi",
    height: 250,
    ratio: 3 / 2,
  },
  {
    id: "10",
    src: "https://images.unsplash.com/photo-1470770903676-69b98201ea1c?w=400&q=80",
    title: "Night Sky",
    author: "Nathan Anderson",
    height: 210,
    ratio: 3 / 2,
  },
  {
    id: "11",
    src: "https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=400&q=80",
    title: "Valley View",
    author: "Ales Krivec",
    height: 270,
    ratio: 3 / 2,
  },
  {
    id: "12",
    src: "https://images.unsplash.com/photo-1500534314263-0869cef6150a?w=400&q=80",
    title: "Ocean Cliff",
    author: "Jeremy Bishop",
    height: 230,
    ratio: 3 / 2,
  },
]

const COLUMNS = 3
const GAP = 12
const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

function useMasonryLayout(items: ImageItem[], columns: number) {
  const colHeights = Array(columns).fill(0) as number[]
  const positioned = items.map((item) => {
    const shortestCol = colHeights.indexOf(Math.min(...colHeights))
    const top = colHeights[shortestCol]
    colHeights[shortestCol] += item.height + GAP
    return { ...item, col: shortestCol, top }
  })
  const totalHeight = Math.max(...colHeights)
  return { positioned, totalHeight }
}

function DetailCard({ item, onClose }: { item: ImageItem; onClose: () => void }) {
  const [hdLoaded, setHdLoaded] = useState(false)
  const hdSrc = item.src.replace("w=400", "w=800")

  useEffect(() => {
    setHdLoaded(false)
    const img = new Image()
    img.src = hdSrc
    img.onload = () => setHdLoaded(true)
    return () => { img.onload = null }
  }, [hdSrc])

  return (
    <motion.div
      layoutId={`card-${item.id}`}
      className="relative z-10 w-full max-w-[560px] my-8 mx-4 rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 shadow-2xl"
      transition={SPRING}
    >
      {/* 关闭按钮 */}
      <motion.button
        className="absolute top-3 right-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm cursor-pointer border-none hover:bg-black/60 transition-colors"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.5 }}
        transition={{ delay: 0.15 }}
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </motion.button>

      {/* 图片容器 — 固定宽高比，不会因加载而跳动 */}
      <div className="relative w-full" style={{ aspectRatio: `${item.ratio}` }}>
        {/* 缩略图（已缓存，秒出）作为 layoutId 共享元素 */}
        <motion.img
          layoutId={`img-${item.id}`}
          src={item.src}
          alt={item.title}
          className="absolute inset-0 w-full h-full object-cover"
          transition={SPRING}
        />
        {/* 高清图在后台加载完后淡入覆盖 */}
        {hdLoaded && (
          <motion.img
            src={hdSrc}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
        )}
      </div>

      {/* 详情内容 — 交错入场 */}
      <motion.div
        className="p-6 space-y-4"
        initial="hidden"
        animate="visible"
        exit="hidden"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } },
        }}
      >
        <motion.h2
          className="text-xl font-bold text-zinc-900 dark:text-zinc-100"
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          {item.title}
        </motion.h2>

        <motion.div
          className="flex items-center gap-3"
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-indigo-400 to-pink-400 flex items-center justify-center text-white text-sm font-bold">
            {item.author[0]}
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{item.author}</p>
            <p className="text-xs text-zinc-500">Photographer</p>
          </div>
        </motion.div>

        <motion.p
          className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed"
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          A beautiful capture of nature's finest moments. This photograph showcases the incredible
          beauty found in our natural world, reminding us of the wonders that surround us every day.
        </motion.p>

        <motion.div
          className="flex gap-2 flex-wrap"
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          {["Nature", "Landscape", "Photography", "Scenic"].map((tag) => (
            <span
              key={tag}
              className="px-3 py-1 text-xs font-medium rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </motion.div>

        <motion.div
          className="flex gap-3 pt-2"
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          <button className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors cursor-pointer border-none">
            Save
          </button>
          <button className="flex-1 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-sm font-medium transition-colors cursor-pointer border-none">
            Share
          </button>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}

export default function QQ() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [animatingId, setAnimatingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { positioned, totalHeight } = useMasonryLayout(DEMO_IMAGES, COLUMNS)
  const colWidth = containerWidth > 0
    ? (containerWidth - GAP * (COLUMNS - 1)) / COLUMNS
    : 200

  const selectedItem = selectedId
    ? DEMO_IMAGES.find((img) => img.id === selectedId) ?? null
    : null

  const handleSelect = useCallback((id: string) => {
    setAnimatingId(id)
    setSelectedId(id)
  }, [])

  const handleClose = useCallback(() => {
    setSelectedId(null)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedId, handleClose])

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* DottedMap 背景层 */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="relative h-full w-full">
          <div className="to-background absolute inset-0 bg-radial from-transparent to-200%" />
          <DottedMap markers={markers} pulse />
        </div>
      </div>

      {/* 图片瀑布流 */}
      <div
        ref={scrollRef}
        className="relative z-10 h-full w-full overflow-y-auto px-4 py-4"
      >
        <div ref={containerRef} className="relative mx-auto max-w-[900px]" style={{ height: totalHeight }}>
          {positioned.map((item) => (
            <motion.div
              key={item.id}
              className="absolute cursor-pointer group"
              style={{
                width: colWidth,
                height: item.height,
                left: item.col * (colWidth + GAP),
                top: item.top,
                zIndex: animatingId === item.id ? 50 : 1,
              }}
              onClick={() => handleSelect(item.id)}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <motion.div
                layoutId={`card-${item.id}`}
                className="h-full w-full rounded-2xl overflow-hidden shadow-md"
                transition={SPRING}
              >
                <motion.img
                  layoutId={`img-${item.id}`}
                  src={item.src}
                  alt={item.title}
                  className="h-full w-full object-cover"
                  transition={SPRING}
                />
              </motion.div>
              <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent rounded-b-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <p className="text-white text-sm font-medium truncate">{item.title}</p>
                <p className="text-white/70 text-xs">{item.author}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* 详情弹框 — 共享元素过渡 */}
      <AnimatePresence onExitComplete={() => setAnimatingId(null)}>
        {selectedItem && (
          <motion.div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={handleClose}
            />

            <DetailCard item={selectedItem} onClose={handleClose} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
