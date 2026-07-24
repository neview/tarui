import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "motion/react";
import { KuaishouCard } from "./KuaishouCard";
import { WxRibaoFormData } from "./KuaishouForm";
import { Alert, useAlert } from "@/components/ui/alert";
import { ScrollText, Copy, Check, Loader2, AlertCircle, Cloud, HardDrive } from "lucide-react";
import { Meteors } from "@/components/ui/meteors";
import { OperationLogButton } from "@/components/OperationLog";
import { logOperation } from "@/utils/operationLog";
import { getWxRibao, getWxRibaoStatus, cancelWxRibao } from "@/utils/api";
import styles from "./index.module.scss";

type RibaoMode = "remote" | "local";

const LOG_PAGE = "kuaishou";
const LOG_PAGE_LABEL = "微信日报";

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

function LogPanel({ logs, loading }: { logs: string[]; loading: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const isSeparator = (line: string) => /^[─━─\-=]{3,}$/.test(line.trim());

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-[280px] overflow-y-auto rounded-xl border border-border bg-muted/30 dark:bg-muted/10 p-4 text-sm leading-relaxed select-text"
    >
      {logs.length === 0 && !loading ? (
        <span className="text-muted-foreground">执行操作后将在此显示日志...</span>
      ) : (
        <div>
          {logs.map((line, i) =>
            isSeparator(line) ? (
              <hr key={i} className="my-2 border-border" />
            ) : (
              <div
                key={i}
                className="py-[3px] break-words text-foreground/85"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {line}
              </div>
            )
          )}
          {loading && (
            <div className="py-[3px]">
              <span className="inline-block text-indigo-400 animate-pulse">●●●</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Kuaishou() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [mode, setMode] = useState<RibaoMode>("remote");
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
  const unlistenRef = useRef<(() => void) | null>(null);

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

  // 展示二维码弹框（远程/本地模式共用）
  const showQr = useCallback((imageUrl: string) => {
    if (qrShownRef.current) return;
    qrShownRef.current = true;
    setQrImgLoading(true);
    setQrImgError(false);
    setQrCode(imageUrl);
    setQrModalOpen(true);
    setQrStatus("请用微信扫码登录（有效期约2分钟）");
  }, []);

  // 追加一批日志（并在检测到「扫码成功」时关闭二维码弹框）
  const appendLogEntries = useCallback(
    (entries: { time: string; msg: string }[]) => {
      if (entries.length === 0) return;
      setLogs((prev) => [...prev, ...entries.map((l) => `[${l.time}] ${l.msg}`)]);
      if (entries.some((l) => typeof l.msg === "string" && l.msg.includes("扫码成功"))) {
        closeQrModal();
      }
    },
    [closeQrModal]
  );

  // 处理任务终态（远程/本地模式共用）
  const finishWith = useCallback(
    (status: string, data?: string | string[], message?: string) => {
      switch (status) {
        case "success":
          closeQrModal();
          if (data) {
            const entries = Array.isArray(data) ? data : [data];
            const lines = entries.flatMap((e) => e.split("\n"));
            setLogs((prev) => [...prev, "───────────────────", ...lines]);
          }
          showSuccess("日报获取完成");
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "获取日报",
            status: "success",
            detail: "日报获取完成",
          });
          break;
        case "expired":
          setQrStatus("⏰ 二维码已过期，请重新获取");
          showError(message || "二维码已过期");
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "获取日报",
            status: "error",
            detail: message || "二维码已过期",
          });
          break;
        case "error":
          closeQrModal();
          showError(message || "执行过程出错");
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "获取日报",
            status: "error",
            detail: message || "执行过程出错",
          });
          break;
        case "cancelled":
          closeQrModal();
          setLogs((prev) => [...prev, "⏹ 任务已被取消"]);
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "获取日报",
            status: "info",
            detail: "任务已被取消",
          });
          break;
      }
    },
    [closeQrModal, showSuccess, showError]
  );

  const cancelAll = useCallback(() => {
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「取消执行」",
      status: "info",
      detail: "用户主动取消日报获取任务",
    });
    cancelledRef.current = true;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stopPolling();
    closeQrModal();

    if (mode === "local") {
      // 本地脚本：优雅通知 Python 取消（关闭浏览器后自行退出），并解绑事件监听
      invoke("stop_wx_ribao").catch(() => {});
      unlistenRef.current?.();
      unlistenRef.current = null;
    } else {
      // 远程接口：通知后端取消会话
      const sid = sessionIdRef.current;
      if (sid) {
        cancelWxRibao(sid).catch(() => {});
        sessionIdRef.current = null;
      }
    }

    setLogs((prev) => [...prev, "⏹ 已取消执行"]);
    setLoading(false);
    lastLogCountRef.current = 0;
    qrShownRef.current = false;
    console.log("[wx-ribao] 用户取消了所有操作");
  }, [stopPolling, closeQrModal, mode]);

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
          appendLogEntries(res.logs.slice(lastLogCountRef.current));
          lastLogCountRef.current = res.logs.length;
        }

        if (res.status === "need_login" && res.imageUrl) {
          showQr(res.imageUrl);
        }

        if (["success", "expired", "error", "cancelled"].includes(res.status)) {
          stopPolling();
          finishWith(res.status, res.data, res.message);
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
  }, [stopPolling, closeQrModal, showError, appendLogEntries, showQr, finishWith]);

  // 本地脚本模式：调用 Tauri 命令运行本地 wx_ribao.py，通过 wx-ribao-log 事件驱动日志/二维码/结果。
  const runLocal = useCallback(
    async (formData: WxRibaoFormData) => {
      let resultReceived = false;

      unlistenRef.current?.();
      const unlisten = await listen<string>("wx-ribao-log", (event) => {
        if (cancelledRef.current) return;
        const line = event.payload;

        if (line.startsWith("WXRIBAO_LOG:")) {
          try {
            const entry = JSON.parse(line.slice("WXRIBAO_LOG:".length));
            appendLogEntries([entry]);
          } catch {
            /* 忽略无法解析的行 */
          }
        } else if (line.startsWith("WXRIBAO_QR:")) {
          try {
            const { imageUrl } = JSON.parse(line.slice("WXRIBAO_QR:".length));
            if (imageUrl) showQr(imageUrl);
          } catch {
            /* ignore */
          }
        } else if (line.startsWith("WXRIBAO_RESULT:")) {
          try {
            const r = JSON.parse(line.slice("WXRIBAO_RESULT:".length));
            resultReceived = true;
            finishWith(r.status, r.data, r.message);
          } catch {
            /* ignore */
          }
        } else if (line.trim()) {
          // 其它原始输出（如 Python 报错）直接展示，便于排查本地环境问题
          setLogs((prev) => [...prev, line]);
        }
      });
      unlistenRef.current = unlisten;

      setLogs(["▶ 正在启动本地脚本..."]);

      try {
        await invoke("run_wx_ribao", {
          params: {
            startDate: formData.startDate,
            endDate: formData.endDate,
            outputFormat: formData.outputFormat,
            indentInTheLine: formData.indentInTheLine ? "true" : "false",
          },
        });
        if (!cancelledRef.current && !resultReceived) {
          const msg =
            "本地脚本已退出但未返回结果，请确认已安装 Python 及 playwright，并已安装 Edge/Chrome 或执行 playwright install chromium";
          showError(msg);
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "获取日报",
            status: "error",
            detail: msg,
          });
        }
      } catch (err) {
        if (cancelledRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLogs((prev) => [...prev, `✖ 本地脚本异常: ${msg}`]);
        showError(msg);
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "获取日报",
          status: "error",
          detail: `本地脚本异常: ${msg}`,
        });
      } finally {
        unlistenRef.current?.();
        unlistenRef.current = null;
        setLoading(false);
      }
    },
    [appendLogEntries, showQr, finishWith, showError]
  );

  const handleFormSubmit = async (formData: WxRibaoFormData) => {
    if (loading) return;

    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「获取日报」",
      status: "info",
      detail: `方式=${mode === "local" ? "本地脚本" : "远程接口"}，日期=${formData.startDate || "-"} ~ ${formData.endDate || "-"}`,
    });

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const ac = new AbortController();
    abortRef.current = ac;

    // 复位公共状态
    setLogs([]);
    setLoading(true);
    cancelledRef.current = false;
    stopPolling();
    sessionIdRef.current = null;
    lastLogCountRef.current = 0;
    qrShownRef.current = false;

    // 本地脚本模式
    if (mode === "local") {
      await runLocal(formData);
      return;
    }

    // 远程接口模式
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
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "获取日报",
          status: "error",
          detail: "服务器未返回有效的会话ID",
        });
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
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "获取日报",
        status: "error",
        detail: `请求异常: ${msg}`,
      });
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
          {/* 获取方式切换：远程接口 / 本地脚本 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">获取方式</span>
            <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
              <ModeButton
                active={mode === "remote"}
                onClick={() => setMode("remote")}
                disabled={loading}
                icon={<Cloud className="size-3.5" />}
                label="远程接口"
              />
              <ModeButton
                active={mode === "local"}
                onClick={() => setMode("local")}
                disabled={loading}
                icon={<HardDrive className="size-3.5" />}
                label="本地脚本"
              />
            </div>
            <span className="text-[11px] text-muted-foreground/70">
              {mode === "remote"
                ? "调用后端服务（默认）"
                : "服务器不可用时的兜底，需本机已装 Python 及 playwright（优先复用系统 Edge/Chrome）"}
            </span>
          </div>
          <KuaishouCard onSubmit={handleFormSubmit} onCancel={cancelAll} loading={loading} />
        </div>
        <div className="flex flex-col min-h-0 min-w-0">
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <ScrollText className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">执行日志</span>
                {loading && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                )}
                <OperationLogButton page={LOG_PAGE} pageLabel={LOG_PAGE_LABEL} className="ml-1" />
              </div>
              {logs.length > 0 && (() => {
                const sepIdx = logs.lastIndexOf("───────────────────");
                const hasResult = sepIdx !== -1 && sepIdx < logs.length - 1;
                return (
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted cursor-pointer"
                    onClick={() => {
                      const text = hasResult
                        ? logs.slice(sepIdx + 1).join("\n")
                        : logs.join("\n");
                      navigator.clipboard.writeText(text);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? "已复制" : hasResult ? "复制结果" : "复制"}
                  </button>
                );
              })()}
            </div>
            <LogPanel logs={logs} loading={loading} />
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

function ModeButton({
  active,
  onClick,
  disabled,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
