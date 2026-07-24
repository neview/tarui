import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { ScrollText, X, Copy, Check, Trash2, CheckCircle2, XCircle, Info, FolderOpen, HardDrive, FolderCog, RotateCcw } from "lucide-react";
import {
  getOperationLogs,
  clearOperationLogs,
  subscribeOperationLogs,
  formatOperationLogsText,
  getOperationLogFilePath,
  revealOperationLogFile,
  getLogDir,
  setLogDir,
  type OperationLogEntry,
} from "@/utils/operationLog";

interface OperationLogButtonProps {
  /** 页面标识，与写入日志时使用的 page 一致 */
  page: string;
  /** 页面中文名，展示在弹框标题 */
  pageLabel: string;
  className?: string;
}

/** 「查看操作日志」按钮 + 日志弹框，记录到本地并可查看/复制/清空 */
export function OperationLogButton({ page, pageLabel, className = "" }: OperationLogButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="查看操作日志"
        className={
          "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-muted cursor-pointer " +
          className
        }
      >
        <ScrollText className="size-3.5" />
        查看操作日志
      </button>
      {open && <OperationLogDialog page={page} pageLabel={pageLabel} onClose={() => setOpen(false)} />}
    </>
  );
}

function OperationLogDialog({
  page,
  pageLabel,
  onClose,
}: {
  page: string;
  pageLabel: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<OperationLogEntry[]>(() => getOperationLogs(page));
  const [copied, setCopied] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [customDir, setCustomDir] = useState(() => getLogDir());

  const refresh = useCallback(() => setEntries(getOperationLogs(page)), [page]);

  const refreshPath = useCallback(() => {
    getOperationLogFilePath()
      .then(setFilePath)
      .catch(() => setFilePath(""));
  }, []);

  useEffect(() => {
    refresh();
    const unsub = subscribeOperationLogs(() => {
      refresh();
      setCustomDir(getLogDir());
      refreshPath();
    });
    return unsub;
  }, [refresh, refreshPath]);

  useEffect(() => {
    refreshPath();
  }, [refreshPath]);

  const handleChooseDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择操作日志保存文件夹",
      });
      if (typeof selected === "string") {
        setLogDir(selected);
        setCustomDir(selected);
        refreshPath();
      }
    } catch {
      /* 用户取消或不可用时忽略 */
    }
  };

  const handleResetDir = () => {
    setLogDir("");
    setCustomDir("");
    refreshPath();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = () => {
    navigator.clipboard.writeText(formatOperationLogsText(entries)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClear = () => {
    clearOperationLogs(page);
    refresh();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">操作日志</span>
            <span className="text-xs text-muted-foreground">· {pageLabel}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {entries.length} 条
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              disabled={entries.length === 0}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 cursor-pointer"
              title="复制全部日志"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "已复制" : "复制"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={entries.length === 0}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40 cursor-pointer"
              title="清空本页日志"
            >
              <Trash2 className="size-3.5" />
              清空
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
              title="关闭"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {entries.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <ScrollText className="size-8 opacity-40" />
              <span className="text-sm">暂无操作日志</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((e) => (
                <LogRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </div>

        {/* 底部：磁盘日志文件路径与保存位置设置 */}
        <div className="flex flex-col gap-1.5 border-t border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-[11px] text-muted-foreground">日志文件：</span>
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-foreground/70"
              title={filePath || "获取路径中..."}
            >
              {filePath || "获取路径中..."}
            </span>
            <button
              type="button"
              onClick={() => {
                revealOperationLogFile().catch(() => {});
              }}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
              title="在文件管理器中定位"
            >
              <FolderOpen className="size-3.5" />
              打开文件夹
            </button>
          </div>
          <div className="flex items-center gap-2 pl-[22px]">
            <span className="shrink-0 text-[11px] text-muted-foreground/70">
              {customDir ? "保存位置：自定义" : "保存位置：默认（安装根目录）"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={handleChooseDir}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                title="选择自定义保存文件夹"
              >
                <FolderCog className="size-3.5" />
                更改目录
              </button>
              {customDir && (
                <button
                  type="button"
                  onClick={handleResetDir}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                  title="恢复为默认安装根目录"
                >
                  <RotateCcw className="size-3.5" />
                  恢复默认
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function LogRow({ entry }: { entry: OperationLogEntry }) {
  const time = new Date(entry.timestamp).toLocaleString();
  const icon =
    entry.status === "success" ? (
      <CheckCircle2 className="size-4 text-emerald-500" />
    ) : entry.status === "error" ? (
      <XCircle className="size-4 text-red-500" />
    ) : (
      <Info className="size-4 text-sky-500" />
    );

  return (
    <li className="flex gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{entry.action}</span>
          <span className="text-[11px] text-muted-foreground/70">{time}</span>
        </div>
        {entry.detail && (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {entry.detail}
          </div>
        )}
      </div>
    </li>
  );
}
