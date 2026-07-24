// 操作日志工具：把用户在各页面点击按钮、执行功能的结果记录到本地。
// 记录同时写入两处：
//   1. localStorage —— 供应用内「查看操作日志」弹框快速读取；
//   2. 磁盘文件 —— 通过 Tauri 命令写入 exe 同级目录（安装后的“安装根目录”），文件名 operation-logs.log。
// 每条记录包含：时间、所在页面、点击的按钮/操作、执行结果状态、以及结果详情。

import { invoke } from "@tauri-apps/api/core";

export type OperationStatus = "info" | "success" | "error";

export interface OperationLogEntry {
  id: string;
  /** 页面标识，如 "feiji" / "kuaishou" / "weixin" / "qq" */
  page: string;
  /** 页面中文名，便于在日志里直接展示 */
  pageLabel: string;
  /** 点击的按钮 / 执行的操作名称 */
  action: string;
  /** 执行结果状态 */
  status: OperationStatus;
  /** 结果详情（成功信息、错误信息、参数摘要等） */
  detail: string;
  /** 记录时间（ISO 字符串） */
  timestamp: string;
}

const STORAGE_KEY = "app-operation-logs-v1";
// 自定义日志文件夹路径（为空则写入默认的安装根目录）
const DIR_KEY = "app-operation-log-dir-v1";
// 最多保留的条数，避免无限增长
const MAX_ENTRIES = 1000;

const listeners = new Set<() => void>();

function readAll(): OperationLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OperationLogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: OperationLogEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* localStorage 不可用时静默忽略，不影响主流程 */
  }
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 获取用户自定义的日志文件夹路径（未设置时返回空字符串，表示使用默认安装根目录） */
export function getLogDir(): string {
  try {
    return localStorage.getItem(DIR_KEY) || "";
  } catch {
    return "";
  }
}

/** 设置自定义日志文件夹路径；传入空字符串表示恢复为默认安装根目录 */
export function setLogDir(dir: string) {
  try {
    if (dir) localStorage.setItem(DIR_KEY, dir);
    else localStorage.removeItem(DIR_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

export interface LogOperationInput {
  page: string;
  pageLabel: string;
  action: string;
  status?: OperationStatus;
  detail?: string;
}

/** 记录一条操作日志到本地 */
export function logOperation(input: LogOperationInput): OperationLogEntry {
  const entry: OperationLogEntry = {
    id: genId(),
    page: input.page,
    pageLabel: input.pageLabel,
    action: input.action,
    status: input.status ?? "info",
    detail: input.detail ?? "",
    timestamp: new Date().toISOString(),
  };
  const all = readAll();
  all.push(entry);
  // 只保留最近 MAX_ENTRIES 条
  const trimmed = all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
  writeAll(trimmed);

  // 追加写入磁盘文件（默认安装根目录，或用户自定义目录）。失败时静默忽略，不影响主流程与内存日志。
  invoke("append_operation_log", {
    record: {
      time: new Date(entry.timestamp).toLocaleString(),
      pageLabel: entry.pageLabel,
      action: entry.action,
      status: entry.status,
      detail: entry.detail,
    },
    dir: getLogDir() || null,
  }).catch(() => {
    /* 例如目录无写入权限时会失败，此处忽略 */
  });

  return entry;
}

/** 获取磁盘日志文件的绝对路径（默认安装根目录，或用户自定义目录下的 operation-logs.log） */
export async function getOperationLogFilePath(): Promise<string> {
  return invoke<string>("get_operation_log_path", { dir: getLogDir() || null });
}

/** 在系统文件管理器中定位磁盘日志文件 */
export async function revealOperationLogFile(): Promise<void> {
  await invoke("reveal_operation_log", { dir: getLogDir() || null });
}

/** 获取操作日志（可按页面过滤），返回按时间倒序（最新在前）的副本 */
export function getOperationLogs(page?: string): OperationLogEntry[] {
  const all = readAll();
  const filtered = page ? all.filter((e) => e.page === page) : all;
  return [...filtered].reverse();
}

/** 清空操作日志（可只清空指定页面的日志） */
export function clearOperationLogs(page?: string) {
  if (!page) {
    writeAll([]);
    return;
  }
  const remaining = readAll().filter((e) => e.page !== page);
  writeAll(remaining);
}

/** 订阅日志变化（用于 UI 实时刷新），返回取消订阅函数 */
export function subscribeOperationLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 把某页日志导出成纯文本，方便复制 */
export function formatOperationLogsText(entries: OperationLogEntry[]): string {
  return entries
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString();
      const statusText =
        e.status === "success" ? "成功" : e.status === "error" ? "失败" : "信息";
      return `[${time}] [${statusText}] ${e.action}${e.detail ? ` -> ${e.detail}` : ""}`;
    })
    .join("\n");
}
