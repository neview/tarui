import { useState, useEffect, useCallback } from "react"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { motion, AnimatePresence } from "motion/react"
import { Download, X, RotateCcw, CheckCircle2, Loader2 } from "lucide-react"

type Stage = "idle" | "available" | "downloading" | "ready" | "error"

export default function UpdateChecker() {
  const [stage, setStage] = useState<Stage>("idle")
  const [update, setUpdate] = useState<Update | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState("")
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const doCheck = async () => {
      try {
        const result = await check()
        if (cancelled) return
        if (result) {
          setUpdate(result)
          setStage("available")
        }
      } catch {
        // silently ignore check errors on startup
      }
    }
    const timer = setTimeout(doCheck, 3000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!update) return
    setStage("downloading")
    setProgress(0)

    try {
      let totalLen = 0
      let downloaded = 0

      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLen = event.data.contentLength
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength
          if (totalLen > 0) {
            setProgress(Math.min(100, Math.round((downloaded / totalLen) * 100)))
          }
        } else if (event.event === "Finished") {
          setProgress(100)
        }
      })

      setStage("ready")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage("error")
    }
  }, [update])

  const handleRelaunch = useCallback(async () => {
    await relaunch()
  }, [])

  if (stage === "idle" || dismissed) return null

  return (
    <AnimatePresence>
      <motion.div
        className="fixed bottom-6 right-6 z-[9999]"
        initial={{ opacity: 0, y: 40, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 40, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
      >
        <div
          className="w-[320px] rounded-2xl p-4 shadow-2xl border border-white/10"
          style={{
            background: "rgba(24, 24, 27, 0.95)",
            backdropFilter: "blur(20px)",
          }}
        >
          {/* 关闭按钮 */}
          {stage !== "downloading" && (
            <button
              onClick={() => setDismissed(true)}
              className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer bg-transparent border-none p-0"
            >
              <X className="h-4 w-4" />
            </button>
          )}

          {/* 发现新版本 */}
          {stage === "available" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Download className="h-5 w-5 text-blue-400" />
                <span className="text-sm font-semibold text-zinc-100">发现新版本</span>
              </div>
              <p className="text-xs text-zinc-400">
                v{update?.version} 已发布{update?.body ? `：${update.body.slice(0, 80)}` : ""}
              </p>
              <button
                onClick={handleDownload}
                className="w-full py-2 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors cursor-pointer border-none"
              >
                立即更新
              </button>
            </div>
          )}

          {/* 下载中 */}
          {stage === "downloading" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 text-blue-400 animate-spin" />
                <span className="text-sm font-semibold text-zinc-100">正在下载更新...</span>
              </div>
              <div className="w-full h-2 rounded-full bg-zinc-700 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-blue-500"
                  initial={{ width: "0%" }}
                  animate={{ width: `${progress}%` }}
                  transition={{ ease: "easeOut" }}
                />
              </div>
              <p className="text-xs text-zinc-500 text-right">{progress}%</p>
            </div>
          )}

          {/* 准备重启 */}
          {stage === "ready" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-400" />
                <span className="text-sm font-semibold text-zinc-100">更新已就绪</span>
              </div>
              <p className="text-xs text-zinc-400">重启应用以完成更新</p>
              <button
                onClick={handleRelaunch}
                className="w-full py-2 rounded-xl bg-green-500 hover:bg-green-600 text-white text-sm font-medium transition-colors cursor-pointer border-none flex items-center justify-center gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                立即重启
              </button>
            </div>
          )}

          {/* 错误 */}
          {stage === "error" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <X className="h-5 w-5 text-red-400" />
                <span className="text-sm font-semibold text-zinc-100">更新失败</span>
              </div>
              <p className="text-xs text-zinc-400">{error}</p>
              <button
                onClick={handleDownload}
                className="w-full py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors cursor-pointer border-none"
              >
                重试
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
