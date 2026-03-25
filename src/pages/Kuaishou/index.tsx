import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { KuaishouCard } from "./KuaishouCard";
import { WxRibaoFormData } from "./KuaishouForm";
import { Alert, useAlert } from "@/components/ui/alert";
import { Terminal, Copy, Check, Loader2, AlertCircle } from "lucide-react";
import { Meteors } from "@/components/ui/meteors";
import { getWxRibao, getWxRibaoStatus, cancelWxRibao } from "@/utils/api";
import styles from "./index.module.scss";

const QR_TOTAL_SECONDS = 120;

function getTimerColor(remaining: number): string {
  if (remaining <= 30) return "#ef4444";
  if (remaining <= 60) return "#f59e0b";
  if (remaining <= 90) return "#6366f1";
  return "#10b981";
}

function formatCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function LogTerminal({ logs, loading }: { logs: string[]; loading: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-[280px] overflow-y-auto rounded-xl bg-[#1e1e2e] dark:bg-[#0d0d14] p-4 font-mono text-sm leading-relaxed select-text"
    >
      {logs.length === 0 && !loading ? (
        <span className="text-gray-500">执行操作后将在此显示日志...</span>
      ) : (
        <>
          <pre className="whitespace-pre-wrap break-words text-gray-200">
            {logs.join("\n")}
          </pre>
          {loading && (
            <span className="inline-block mt-1 text-indigo-400 animate-pulse">▊</span>
          )}
        </>
      )}
    </div>
  );
}

export default function Kuaishou() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [qrStatus, setQrStatus] = useState("正在请求接口...");
  const [copied, setCopied] = useState(false);
  const [qrImgLoading, setQrImgLoading] = useState(true);
  const [qrImgError, setQrImgError] = useState(false);

  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const eyeLeftRef = useRef<HTMLDivElement>(null);
  const eyeRightRef = useRef<HTMLDivElement>(null);

  const [countdown, setCountdown] = useState(QR_TOTAL_SECONDS);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastLogCountRef = useRef(0);
  const qrShownRef = useRef(false);

  useEffect(() => {
    if (!qrModalOpen) return;

    const handleMouseMove = (e: MouseEvent) => {
      const eyeL = eyeLeftRef.current;
      const eyeR = eyeRightRef.current;
      if (!eyeL || !eyeR) return;

      const rectL = eyeL.getBoundingClientRect();
      const rectR = eyeR.getBoundingClientRect();
      const cx = (rectL.left + rectL.right + rectR.left + rectR.right) / 4;
      const cy = (rectL.top + rectL.bottom + rectR.top + rectR.bottom) / 4;

      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxMove = 4;
      const factor = Math.min(maxMove / Math.max(dist, 1), 1);

      setPupilOffset({ x: dx * factor, y: dy * factor });
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [qrModalOpen]);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);

    if (qrModalOpen && qrCode) {
      setCountdown(QR_TOTAL_SECONDS);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [qrModalOpen, qrCode]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const closeQrModal = useCallback(() => {
    setQrModalOpen(false);
    setQrCode("");
    setQrImgLoading(true);
    setQrImgError(false);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stopPolling();
    closeQrModal();

    const sid = sessionIdRef.current;
    if (sid) {
      cancelWxRibao(sid).catch(() => {});
      sessionIdRef.current = null;
    }

    setLogs((prev) => [...prev, "⏹ 已取消执行"]);
    setLoading(false);
    lastLogCountRef.current = 0;
    qrShownRef.current = false;
    console.log("[wx-ribao] 用户取消了所有操作");
  }, [stopPolling, closeQrModal]);

  const startPolling = useCallback((sessionId: string) => {
    stopPolling();
    lastLogCountRef.current = 0;
    qrShownRef.current = false;

    pollingRef.current = setInterval(async () => {
      if (cancelledRef.current || abortRef.current?.signal.aborted) {
        stopPolling();
        return;
      }
      try {
        const res = await getWxRibaoStatus(sessionId);
        if (cancelledRef.current || abortRef.current?.signal.aborted) return;
        console.log("[wx-ribao] 轮询状态:", res);

        if (res.logs && res.logs.length > lastLogCountRef.current) {
          const newEntries = res.logs.slice(lastLogCountRef.current);
          const formatted = newEntries.map((l) => `[${l.time}] ${l.msg}`);
          setLogs((prev) => [...prev, ...formatted]);
          lastLogCountRef.current = res.logs.length;

          if (newEntries.some((l) => l.msg.includes("扫码成功"))) {
            closeQrModal();
          }
        }

        if (res.status === "need_login" && res.imageUrl && !qrShownRef.current) {
          qrShownRef.current = true;
          setQrImgLoading(true);
          setQrImgError(false);
          setQrCode(res.imageUrl);
          setQrModalOpen(true);
          setQrStatus("请用微信扫码登录（有效期约2分钟）");
        }

        if (["success", "expired", "error", "cancelled"].includes(res.status)) {
          stopPolling();

          switch (res.status) {
            case "success":
              closeQrModal();
              if (res.data) {
                const entries = Array.isArray(res.data) ? res.data : [res.data];
                setLogs((prev) => [...prev, "───────────────────", ...entries]);
              }
              showSuccess("日报获取完成");
              break;
            case "expired":
              setQrStatus("⏰ 二维码已过期，请重新获取");
              showError(res.message || "二维码已过期");
              break;
            case "error":
              closeQrModal();
              showError(res.message || "执行过程出错");
              break;
            case "cancelled":
              closeQrModal();
              setLogs((prev) => [...prev, "⏹ 任务已被取消"]);
              break;
          }
          setLoading(false);
          sessionIdRef.current = null;
        }
      } catch (err) {
        if (cancelledRef.current || abortRef.current?.signal.aborted) return;
        stopPolling();
        closeQrModal();
        showError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }, 2000);
  }, [stopPolling, closeQrModal, showSuccess, showError]);

  const handleFormSubmit = async (formData: WxRibaoFormData) => {
    if (cancelledRef.current === false && loading) return;

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const ac = new AbortController();
    abortRef.current = ac;

    setLogs([]);
    setLoading(true);
    cancelledRef.current = false;
    stopPolling();
    sessionIdRef.current = null;
    lastLogCountRef.current = 0;
    qrShownRef.current = false;

    setLogs(["▶ 正在请求服务器..."]);

    try {
      const result = await getWxRibao({
        startDate: formData.startDate,
        endDate: formData.endDate,
        outputFormat: formData.outputFormat,
        indentInTheLine: formData.indentInTheLine ? "True" : "False",
      });

      if (cancelledRef.current || ac.signal.aborted) return;
      console.log("[wx-ribao] 接口返回:", result);

      if (!result.sessionId) {
        setLogs((prev) => [...prev, "✖ 服务器未返回 sessionId"]);
        showError("服务器未返回有效的会话ID");
        setLoading(false);
        return;
      }

      sessionIdRef.current = result.sessionId;
      setLogs((prev) => [...prev, "✔ 已建立会话，开始轮询执行状态..."]);
      startPolling(result.sessionId);
    } catch (err) {
      if (cancelledRef.current || ac.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `✖ 请求异常: ${msg}`]);
      showError(msg);
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className={`${styles.kuaishou_page} relative overflow-hidden`}>
      <Meteors number={30} />

      <Alert alert={alert} onClose={closeAlert} />
      <div
        className={
          styles.content_row +
          " relative z-10 grid min-w-0 gap-6 [grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]"
        }
      >
        <div className="min-w-0">
          <KuaishouCard onSubmit={handleFormSubmit} onCancel={cancelAll} loading={loading} />
        </div>
        <div className="flex flex-col min-h-0 min-w-0">
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">执行日志</span>
                {loading && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                )}
              </div>
              {logs.length > 0 && (
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted cursor-pointer"
                  onClick={() => {
                    navigator.clipboard.writeText(logs.join("\n"));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? "已复制" : "复制"}
                </button>
              )}
            </div>
            <LogTerminal logs={logs} loading={loading} />
          </div>
        </div>
      </div>

      {/* ====== 卡通风格动效二维码弹框 ====== */}
      <AnimatePresence>
        {qrModalOpen && (() => {
          const timerColor = getTimerColor(countdown);
          const progress = countdown / QR_TOTAL_SECONDS;
          const expired = countdown <= 0;
          const qrBoxSize = 214;
          const borderStroke = 5;
          const borderRadius = 16;
          const half = borderStroke / 2;
          const svgSize = qrBoxSize + borderStroke;

          return (
            <motion.div
              className="fixed inset-0 z-[9999] flex items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              onClick={closeQrModal}
            >
              <motion.div
                className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />

              <motion.div
                className="relative z-10"
                style={{ animation: "qr-float 6s ease-in-out infinite" }}
                initial={{ scale: 0.3, y: 80, opacity: 0, rotate: -8 }}
                animate={{ scale: 1, y: 0, opacity: 1, rotate: 0 }}
                exit={{ scale: 0.5, y: 60, opacity: 0, rotate: 6 }}
                transition={{ type: "spring", damping: 12, stiffness: 150, mass: 0.8 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className="relative rounded-3xl bg-white dark:bg-gray-900 p-6 text-center overflow-visible"
                  style={{
                    animation: "qr-breathe 4s ease-in-out infinite",
                    maxWidth: 400,
                    width: "92vw",
                  }}
                >
                  {/* 流光旋转边框 */}
                  <div
                    className="absolute -inset-[2px] rounded-3xl -z-10 opacity-70"
                    style={{
                      background: `conic-gradient(from var(--qr-angle), ${timerColor}, #ec4899, ${timerColor})`,
                      animation: "qr-border-spin 4s linear infinite",
                    }}
                  />
                  <div className="absolute -inset-[0px] rounded-3xl -z-10 bg-white dark:bg-gray-900" />

                  {/* 卡通眼睛 - 跟随鼠标 */}
                  <div className="flex justify-center gap-8 mb-2 mt-1">
                    {[eyeLeftRef, eyeRightRef].map((ref, i) => (
                      <div
                        key={i}
                        ref={ref}
                        className="relative w-11 h-11 rounded-full bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600"
                        style={{
                          animation: "qr-blink 4s ease-in-out infinite",
                          animationDelay: i === 1 ? "0.1s" : "0s",
                          boxShadow: "inset 0 2px 4px rgba(0,0,0,0.06)",
                        }}
                      >
                        <div
                          className="absolute top-1/2 left-1/2 w-[18px] h-[18px] rounded-full bg-gray-800 dark:bg-gray-200 transition-transform duration-75"
                          style={{
                            transform: `translate(calc(-50% + ${pupilOffset.x}px), calc(-50% + ${pupilOffset.y}px))`,
                          }}
                        >
                          <div className="absolute top-[2px] right-[3px] w-[5px] h-[5px] rounded-full bg-white dark:bg-gray-900" />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 表情嘴巴 */}
                  <div className="flex justify-center mb-3">
                    {countdown > 30 ? (
                      <div className="w-8 h-4 border-b-[3px] border-gray-400 dark:border-gray-500 rounded-b-full" />
                    ) : (
                      <div className="w-6 h-5 rounded-full border-2 border-red-400" />
                    )}
                  </div>

                  {/* 标题 */}
                  <h3 className="text-lg font-bold mb-1 flex justify-center gap-[1px]">
                    {"微信扫码登录".split("").map((char, i) => (
                      <span
                        key={i}
                        className="inline-block text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-pink-500 to-amber-500"
                        style={{
                          animation: "qr-wave 2s ease-in-out infinite",
                          animationDelay: `${i * 0.1}s`,
                        }}
                      >
                        {char}
                      </span>
                    ))}
                  </h3>

                  {/* 倒计时 */}
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {qrImgError
                        ? "😢 二维码加载失败，请重新获取"
                        : expired
                          ? "⏰ 二维码已过期，请重新获取"
                          : qrStatus}
                    </p>
                    {!qrImgError && !expired && (
                      <span
                        className="text-xs font-bold px-2 py-0.5 rounded-full"
                        style={{
                          color: timerColor,
                          backgroundColor: `${timerColor}15`,
                          transition: "color 0.5s, background-color 0.5s",
                        }}
                      >
                        {formatCountdown(countdown)}
                      </span>
                    )}
                  </div>

                  {/* 二维码区域 + 方形进度边框 */}
                  <div className="relative flex justify-center py-3">
                    <motion.div
                      className="absolute top-1/2 left-1/2 rounded-2xl -z-0"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 0.2 }}
                      transition={{ duration: 0.5 }}
                      style={{
                        width: qrBoxSize + 40,
                        height: qrBoxSize + 40,
                        background: `radial-gradient(circle, ${timerColor}66, transparent 70%)`,
                        transform: "translate(-50%, -50%)",
                        filter: "blur(18px)",
                        transition: "background 0.5s",
                      }}
                    />

                    <div className="relative" style={{ width: svgSize, height: svgSize }}>
                      <svg
                        className="absolute inset-0 pointer-events-none"
                        width={svgSize}
                        height={svgSize}
                        viewBox={`0 0 ${svgSize} ${svgSize}`}
                        fill="none"
                      >
                        <rect
                          x={half}
                          y={half}
                          width={svgSize - borderStroke}
                          height={svgSize - borderStroke}
                          rx={borderRadius}
                          ry={borderRadius}
                          stroke="currentColor"
                          className="text-gray-200 dark:text-gray-700"
                          strokeWidth={borderStroke}
                        />
                        <rect
                          x={half}
                          y={half}
                          width={svgSize - borderStroke}
                          height={svgSize - borderStroke}
                          rx={borderRadius}
                          ry={borderRadius}
                          stroke={timerColor}
                          strokeWidth={borderStroke}
                          strokeLinecap="round"
                          pathLength={100}
                          strokeDasharray={100}
                          strokeDashoffset={100 * (1 - progress)}
                          style={{
                            transition: "stroke-dashoffset 1s linear, stroke 0.5s ease",
                          }}
                        />
                      </svg>

                      {/* 二维码图片 */}
                      <div
                        className="absolute flex items-center justify-center"
                        style={{
                          inset: borderStroke,
                          borderRadius: borderRadius - 2,
                        }}
                      >
                        <div
                          className="relative overflow-hidden bg-gray-50 dark:bg-gray-800"
                          style={{
                            width: qrBoxSize - 8,
                            height: qrBoxSize - 8,
                            borderRadius: borderRadius - 4,
                            opacity: expired ? 0.3 : 1,
                            transition: "opacity 0.5s",
                          }}
                        >
                          <AnimatePresence mode="wait">
                            {qrImgError ? (
                              /* ——— 加载失败 ——— */
                              <motion.div
                                key="error"
                                className="flex h-full w-full flex-col items-center justify-center gap-3"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                              >
                                <motion.div
                                  animate={{ rotate: [0, -10, 10, -10, 0] }}
                                  transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                                >
                                  <AlertCircle className="h-12 w-12 text-red-400" />
                                </motion.div>
                                <span className="text-sm text-red-400 font-medium">图片加载失败</span>
                              </motion.div>
                            ) : (
                              /* ——— 二维码图片 ——— */
                              <motion.div
                                key="qrcode"
                                className="w-full h-full relative"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.4, ease: "easeOut" }}
                              >
                                {qrImgLoading && (
                                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
                                    <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
                                    <span className="text-xs text-gray-400">图片加载中...</span>
                                  </div>
                                )}
                                <img
                                  src={qrCode}
                                  alt="登录二维码"
                                  className="block"
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "contain",
                                    opacity: qrImgLoading ? 0 : 1,
                                    transition: "opacity 0.4s ease",
                                  }}
                                  onLoad={() => setQrImgLoading(false)}
                                  onError={() => {
                                    setQrImgLoading(false);
                                    setQrImgError(true);
                                  }}
                                />
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {expired && (
                            <div
                              className="absolute inset-0 flex items-center justify-center bg-black/50"
                              style={{ borderRadius: borderRadius - 4 }}
                            >
                              <span className="text-white font-bold text-sm">已过期</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 四角星星 */}
                      {[
                        { top: -4, left: -4, delay: 0 },
                        { top: -4, right: -4, delay: 1.2 },
                        { bottom: -4, left: -4, delay: 0.6 },
                        { bottom: -4, right: -4, delay: 1.8 },
                      ].map((pos, i) => (
                        <span
                          key={i}
                          className="absolute text-sm pointer-events-none"
                          style={{
                            ...pos,
                            color: timerColor,
                            animation: `qr-sparkle 2.4s ease-in-out infinite`,
                            animationDelay: `${pos.delay}s`,
                            transition: "color 0.5s",
                          }}
                        >
                          ✦
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* 关闭按钮 */}
                  <motion.button
                    className="mt-6 px-8 py-2.5 rounded-full font-medium text-sm text-white
                      shadow-lg cursor-pointer border-none outline-none"
                    style={{
                      background: countdown > 30
                        ? "linear-gradient(135deg, #6366f1, #ec4899)"
                        : "linear-gradient(135deg, #ef4444, #f59e0b)",
                      boxShadow: `0 4px 15px ${timerColor}40`,
                      transition: "background 0.5s, box-shadow 0.5s",
                    }}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={closeQrModal}
                  >
                    {expired ? "重新获取" : "我知道啦"}
                  </motion.button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
