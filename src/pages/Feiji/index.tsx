import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Cloud, HardDrive } from "lucide-react";
import { ReleaseCard } from "./ReleaseCard";
import { ReleaseFormData } from "./ReleaseForm";
import { releaseVersion, type ReleaseVersionResponse } from "@/utils/api";
import { Alert, useAlert } from "@/components/ui/alert";
import { AnimatedList } from "@/components/ui/animated-list";
import { OperationLogButton } from "@/components/OperationLog";
import { logOperation } from "@/utils/operationLog";
import styles from "./index.module.scss";

type ReleaseMode = "remote" | "local";

const LOG_PAGE = "feiji";
const LOG_PAGE_LABEL = "发布微信小程序版本";

export default function Feiji() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [logs, setLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<ReleaseMode>("remote");
  const [loading, setLoading] = useState(false);

  const handleFormSubmit = async (data: ReleaseFormData) => {
    // 清空之前的日志
    setLogs([]);
    setLoading(true);

    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「发布版本」",
      status: "info",
      detail: `方式=${mode === "local" ? "本地脚本" : "远程接口"}，版本=${data.version || "-"}，名称=${data.name || "-"}`,
    });

    // 本地脚本模式：监听 release-log 事件，实时把每一行日志追加显示
    let unlisten: (() => void) | undefined;
    if (mode === "local") {
      unlisten = await listen<string>("release-log", (event) => {
        setLogs((prev) => [...prev, event.payload]);
      });
    }

    try {
      // 远程接口：走后端 /api/release-version
      // 本地脚本：走 Tauri 命令 run_release_version（调用本地 release_version.py）
      // 两者返回结构一致：{ code, message, log }
      const result: ReleaseVersionResponse =
        mode === "local"
          ? await invoke<ReleaseVersionResponse>("run_release_version", {
              params: data,
            })
          : await releaseVersion(data);

      // 始终显示 message，根据 code 判断成功或失败
      if (result.code === 1) {
        showSuccess(result.message);
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "发布版本",
          status: "success",
          detail: result.message,
        });
      } else {
        showError(result.message);
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "发布版本",
          status: "error",
          detail: result.message,
        });
      }

      // 远程模式一次性设置日志（后端返回完整 log）；
      // 本地模式的日志已经通过事件实时追加，无需再覆盖。
      if (mode !== "local" && result.log && result.log.length > 0) {
        setLogs(result.log);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "请求失败，请稍后重试";
      showError(msg);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "发布版本",
        status: "error",
        detail: msg,
      });
    } finally {
      unlisten?.();
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className={styles.feiji_page}>
      <Alert alert={alert} onClose={closeAlert} />
      <div className="flex gap-6 h-full">
        <div className="flex-1">
          {/* 发布方式切换：远程接口 / 本地脚本 */}
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">发布方式</span>
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
                : "服务器不可用时的兜底，需本机已安装 Python 及依赖"}
            </span>
          </div>
          <ReleaseCard onSubmit={handleFormSubmit} loading={loading} />
        </div>
        <div className="flex-1">
          <AnimatedList
            logs={logs}
            title="执行日志"
            action={<OperationLogButton page={LOG_PAGE} pageLabel={LOG_PAGE_LABEL} />}
          />
        </div>
      </div>
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
