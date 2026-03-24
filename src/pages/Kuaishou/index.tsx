import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { KuaishouCard } from "./KuaishouCard";
import { WxRibaoFormData } from "./KuaishouForm";
import { Alert, useAlert } from "@/components/ui/alert";
import { AnimatedList } from "@/components/ui/animated-list";
import { Meteors } from "@/components/ui/meteors";
import { Loader2, AlertCircle } from "lucide-react";
import { getWxRibao, type WxRibaoResponse } from "@/utils/api";
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

export default function Kuaishou() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [qrStatus, setQrStatus] = useState("正在获取二维码...");
  const [qrImgLoading, setQrImgLoading] = useState(true);
  const [qrImgError, setQrImgError] = useState(false);

  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const eyeLeftRef = useRef<HTMLDivElement>(null);
  const eyeRightRef = useRef<HTMLDivElement>(null);

  const [countdown, setCountdown] = useState(QR_TOTAL_SECONDS);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    if (qrModalOpen) {
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
    } else {
      if (countdownRef.current) clearInterval(countdownRef.current);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [qrModalOpen]);

  const closeQrModal = useCallback(() => {
    setQrModalOpen(false);
    setQrCode("");
    setQrImgLoading(true);
    setQrImgError(false);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const handleImageResult = (imageUrl: string | undefined) => {
    if (!imageUrl) {
      showError("二维码地址为空，请重试");
      return;
    }
    setQrImgLoading(true);
    setQrImgError(false);
    setQrCode(imageUrl);
    setQrModalOpen(true);
    setQrStatus("请用微信扫码登录（有效期约2分钟）");
    showSuccess("二维码获取成功，请在手机上扫码");
  };

  const handleLogResult = (data: NonNullable<WxRibaoResponse["data"]>) => {
    const entries: string[] = [];

    if (data.logs?.length) {
      entries.push(...data.logs);
    }
    if (data.formatted_text) {
      entries.push(data.formatted_text);
    }
    if (data.count !== undefined) {
      entries.push(`共处理 ${data.count} 条记录`);
    }

    if (entries.length > 0) {
      setLogs(entries);
      showSuccess("日报获取完成");
    } else {
      showSuccess("脚本执行完成，但未返回日志内容");
    }
  };

  const handleFormSubmit = async (formData: WxRibaoFormData) => {
    setLogs([]);
    setLoading(true);

    try {
      const result: Record<string, unknown> = await getWxRibao({
        startDate: formData.startDate,
        endDate: formData.endDate,
        outputFormat: formData.outputFormat,
        indentInTheLine: formData.indentInTheLine ? "True" : "False",
      });

      console.log("[wx-ribao] 接口返回:", result);

      const code = (result.code ?? result.status) as number | undefined;
      const message = result.message as string | undefined;

      if (code !== 1) {
        showError(message || "请求失败，请稍后重试");
        return;
      }

      const imageUrl =
        (result.imageUrl as string) ??
        ((result.data as Record<string, unknown> | undefined)?.imageUrl as string);

      if (imageUrl) {
        handleImageResult(imageUrl);
        return;
      }

      const data = result.data as WxRibaoResponse["data"];
      if (data) {
        switch (data.type) {
          case "image":
            handleImageResult(data.imageUrl);
            break;
          case "log":
            handleLogResult(data);
            break;
          default:
            showError(`未知的响应类型: ${(data as { type: string }).type}`);
        }
      } else {
        showSuccess(message || "操作成功");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(msg);
    } finally {
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
          <KuaishouCard onSubmit={handleFormSubmit} loading={loading} />
        </div>
        <div className="flex flex-col min-h-0 min-w-0">
          <AnimatedList logs={logs} title="运行日志" />
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
                    {/* 背景发光 */}
                    <div
                      className="absolute top-1/2 left-1/2 rounded-2xl opacity-20 -z-0"
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
                      {/* SVG 圆角矩形进度边框 */}
                      <svg
                        className="absolute inset-0 pointer-events-none"
                        width={svgSize}
                        height={svgSize}
                        viewBox={`0 0 ${svgSize} ${svgSize}`}
                        fill="none"
                      >
                        {/* 底部轨道 */}
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
                        {/* 进度边框 - 从左上角顺时针缩短 */}
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
                          {qrImgLoading && !qrImgError && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
                              <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
                              <span className="text-xs text-gray-400">努力加载中...</span>
                            </div>
                          )}

                          {qrImgError ? (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                              <motion.div
                                animate={{ rotate: [0, -10, 10, -10, 0] }}
                                transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                              >
                                <AlertCircle className="h-12 w-12 text-red-400" />
                              </motion.div>
                              <span className="text-sm text-red-400 font-medium">图片加载失败</span>
                            </div>
                          ) : (
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
                          )}

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
