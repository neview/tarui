import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react";
import {
  FolderGit2,
  FolderPlus,
  FolderSearch,
  Folder,
  FolderX,
  FolderCheck,
  Eye,
  EyeOff,
  File as FileIcon,
  RefreshCw,
  Square,
  Settings2,
  Trash2,
  GitBranch,
  Plus,
  ChevronUp,
  ChevronDown,
  Check,
  X,
  Terminal,
  Eraser,
  Pencil,
  Copy,
  Save,
  CircleAlert,
  Sparkles,
  ScanLine,
  Rocket,
  ListTree,
  ChevronRight,
  GripVertical,
} from "lucide-react";
import { OperationLogButton } from "@/components/OperationLog";
import { logOperation } from "@/utils/operationLog";

const LOG_PAGE = "qq";
const LOG_PAGE_LABEL = "Git 一键提交";

// ==================== Types ====================

interface CommandStep {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  continueOnError: boolean;
  allowEmptyCommit: boolean;
}

interface CommitPreset {
  id: string;
  name: string;
  steps: CommandStep[];
}

interface PipelineConfig {
  presets: CommitPreset[];
  activePresetId: string;
  onRepoError: "stop-all" | "skip-repo" | "continue";
}

interface ChangedFile {
  status: string;
  path: string;
}

interface GitStatus {
  path: string;
  name: string;
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  files: ChangedFile[];
  error: string | null;
}

/** 扫描时被省略的条目（没有 git 关联的文件/文件夹） */
interface SkippedEntry {
  path: string;
  name: string;
  /** file = 文件；dir = 文件夹但没有 git；ignored = 依赖/产物/隐藏目录 */
  kind: "file" | "dir" | "ignored";
  reason: string;
}

/** 跳过检测清单里的条目 */
type SkipKind = SkippedEntry["kind"] | "manual";

interface SkipItem {
  path: string;
  name: string;
  kind: SkipKind;
  reason: string;
}

interface GitScanResult {
  repos: GitStatus[];
  total: number;
  changed: number;
  truncated: boolean;
  skipped: SkippedEntry[];
  skipped_total: number;
}

interface ToastData {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface RepoMeta {
  /** 仓库绑定的预设 id。未设置时回退到全局 activePresetId */
  presetId?: string;
  /** 上次使用的提交备注，用于快速重复提交 */
  lastMessage?: string;
}

/**
 * 一键提交的失败/取消结果。
 * 失败时工作区可能已经变干净（比如 commit 成功、push 失败），
 * 靠它把卡片留在「待提交」栏里并显示失败原因，而不是被当成已完成清掉。
 */
interface RunOutcome {
  status: "failed" | "cancelled";
  /** 简要原因，优先取失败步骤那一行日志 */
  reason: string;
  /** 失败步骤前后的关键输出，方便日志被清空后仍能看到原因 */
  detail: string[];
  presetName: string;
  at: number;
}

interface PipelineRunSummary {
  succeeded: string[];
  failed: string[];
  cancelled: string[];
}

// ==================== Constants ====================

const REPOS_KEY = "douyin-git-repos-v1";
const PIPELINE_KEY = "douyin-git-pipeline-v1";
const REPO_META_KEY = "douyin-git-repo-meta-v1";
const CHROME_COLLAPSED_KEY = "douyin-git-chrome-collapsed-v1";
const SCAN_ROOT_KEY = "douyin-git-scan-root-v1";
const SCAN_DEPTH_KEY = "douyin-git-scan-depth-v1";
const SCANNED_REPOS_KEY = "douyin-git-scanned-repos-v1";
const SKIP_LIST_KEY = "douyin-git-skip-list-v1";
const STATUSES_KEY = "douyin-git-statuses-v1";
const SECTIONS_OPEN_KEY = "douyin-git-sections-open-v1";
const RUN_RESULTS_KEY = "douyin-git-run-results-v1";

/** 失败详情最多保留几行输出 */
const OUTCOME_DETAIL_LINES = 8;

const DEFAULT_SCAN_DEPTH = 3;
const SCAN_DEPTH_OPTIONS = [1, 2, 3, 4, 5];

let toastCounter = 0;
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 项目卡片彩条候选色（Tailwind gradient class 片段）
const PROJECT_ACCENTS = [
  "from-violet-500 to-indigo-500",
  "from-sky-500 to-cyan-500",
  "from-pink-500 to-rose-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-500",
  "from-blue-500 to-indigo-500",
  "from-lime-500 to-emerald-500",
  "from-teal-500 to-cyan-500",
  "from-orange-500 to-pink-500",
  "from-indigo-500 to-blue-500",
  "from-rose-500 to-fuchsia-500",
  "from-cyan-500 to-sky-500",
];

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pickProjectAccent(path: string): string {
  return PROJECT_ACCENTS[hashString(path) % PROJECT_ACCENTS.length];
}

const DEFAULT_CONFIG: PipelineConfig = {
  activePresetId: "default-standard",
  onRepoError: "stop-all",
  presets: [
    {
      id: "default-standard",
      name: "标准提交",
      steps: [
        { id: "s1", name: "添加所有改动", command: "git add -A", enabled: true, continueOnError: false, allowEmptyCommit: false },
        { id: "s2", name: "提交", command: 'git commit -m "{{message}}"', enabled: true, continueOnError: false, allowEmptyCommit: true },
        { id: "s3", name: "推送", command: "git push", enabled: true, continueOnError: false, allowEmptyCommit: false },
      ],
    },
    {
      id: "default-rebase",
      name: "Rebase 后推送",
      steps: [
        { id: "r1", name: "添加所有改动", command: "git add -A", enabled: true, continueOnError: false, allowEmptyCommit: false },
        { id: "r2", name: "提交", command: 'git commit -m "{{message}}"', enabled: true, continueOnError: false, allowEmptyCommit: true },
        { id: "r3", name: "拉取 (rebase)", command: "git pull --rebase", enabled: true, continueOnError: false, allowEmptyCommit: false },
        { id: "r4", name: "推送", command: "git push", enabled: true, continueOnError: false, allowEmptyCommit: false },
      ],
    },
    {
      id: "default-local",
      name: "仅本地提交",
      steps: [
        { id: "l1", name: "添加所有改动", command: "git add -A", enabled: true, continueOnError: false, allowEmptyCommit: false },
        { id: "l2", name: "提交", command: 'git commit -m "{{message}}"', enabled: true, continueOnError: false, allowEmptyCommit: true },
      ],
    },
  ],
};

// ==================== Helpers ====================

function loadRepos(): string[] {
  try {
    const raw = localStorage.getItem(REPOS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRepos(repos: string[]) {
  localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
}

function loadStringList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveStringList(key: string, list: string[]) {
  localStorage.setItem(key, JSON.stringify(list));
}

function loadScanDepth(): number {
  const n = Number(localStorage.getItem(SCAN_DEPTH_KEY));
  return SCAN_DEPTH_OPTIONS.includes(n) ? n : DEFAULT_SCAN_DEPTH;
}

function loadSkipList(): SkipItem[] {
  try {
    const raw = localStorage.getItem(SKIP_LIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SkipItem => !!x && typeof x.path === "string" && typeof x.kind === "string",
    );
  } catch {
    return [];
  }
}

function loadStatuses(): Record<string, GitStatus> {
  try {
    const raw = localStorage.getItem(STATUSES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadRunResults(): Record<string, RunOutcome> {
  try {
    const raw = localStorage.getItem(RUN_RESULTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, RunOutcome> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([path, value]) => {
      const v = value as Partial<RunOutcome> | null;
      if (!v || (v.status !== "failed" && v.status !== "cancelled")) return;
      out[path] = {
        status: v.status,
        reason: typeof v.reason === "string" ? v.reason : "执行失败",
        detail: Array.isArray(v.detail) ? v.detail.filter((l): l is string => typeof l === "string") : [],
        presetName: typeof v.presetName === "string" ? v.presetName : "",
        at: typeof v.at === "number" ? v.at : Date.now(),
      };
    });
    return out;
  } catch {
    return {};
  }
}

/** 工作区改动文件总数 */
function changeCount(status?: GitStatus): number {
  if (!status || !status.is_repo) return 0;
  return (
    status.modified +
    status.added +
    status.deleted +
    status.renamed +
    status.untracked +
    status.conflicted
  );
}

/** 由 git 状态推导该项目属于哪一栏 */
function classifyRepo(status?: GitStatus): "dirty" | "clean" | "non-git" {
  // 尚未检测过的项目先当作待处理，检测后再归类
  if (!status) return "dirty";
  if (!status.is_repo) return "non-git";
  return changeCount(status) > 0 ? "dirty" : "clean";
}

const SKIP_REASON_MANUAL = "手动跳过检测";

function loadConfig(): PipelineConfig {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.presets && parsed.presets.length) return parsed;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG;
}

function saveConfig(cfg: PipelineConfig) {
  localStorage.setItem(PIPELINE_KEY, JSON.stringify(cfg));
}

function loadRepoMeta(): Record<string, RepoMeta> {
  try {
    const raw = localStorage.getItem(REPO_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRepoMeta(meta: Record<string, RepoMeta>) {
  localStorage.setItem(REPO_META_KEY, JSON.stringify(meta));
}

function substitutePlaceholders(command: string, vars: Record<string, string>): string {
  return command.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function statusBadgeColor(code: string): string {
  if (code === "??") return "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/20";
  if (code.includes("M")) return "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/20";
  if (code.includes("A")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/20";
  if (code.includes("D")) return "bg-rose-500/15 text-rose-500 dark:text-rose-300 border-rose-500/20";
  if (code.includes("R")) return "bg-indigo-500/15 text-indigo-500 dark:text-indigo-300 border-indigo-500/20";
  if (code.includes("U")) return "bg-red-500/15 text-red-500 dark:text-red-300 border-red-500/20";
  return "bg-slate-500/15 text-slate-500 dark:text-slate-300 border-slate-500/20";
}

function getRepoName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 后端的仓库级失败标记（步骤级失败是缩进的 "  ✗ 失败"，可能被 continueOnError 放过） */
function isRepoFailureLine(line: string): boolean {
  return line.startsWith("✗") && (line.includes("执行失败") || line.includes("目录不存在"));
}

/** 从失败日志里提炼一句简短原因 */
function buildFailureReason(failureLines: string[], fallback: string): string {
  const stepLine = failureLines.find((l) => !isRepoFailureLine(l)) ?? failureLines[0];
  const raw = (stepLine ?? "").replace(/^✗\s*/, "").trim();
  if (!raw) return fallback;
  const m = /^失败\s+exit=(-?\d+)\s*\((.+)\)$/.exec(raw);
  if (m) return `步骤「${m[2]}」失败（exit ${m[1]}）`;
  return raw;
}

function formatOutcomeTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

// ==================== Toast ====================

function Toasts({ toasts, onRemove }: { toasts: ToastData[]; onRemove: (id: number) => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30, scale: 0.9 }}
            onAnimationComplete={() => {
              setTimeout(() => onRemove(t.id), 3000);
            }}
            className={`pointer-events-auto px-4 py-2.5 rounded-xl backdrop-blur-xl border text-sm font-medium shadow-lg flex items-center gap-2
              ${t.type === "success" ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-700 dark:text-emerald-200" : ""}
              ${t.type === "error" ? "bg-red-500/20 border-red-500/30 text-red-700 dark:text-red-200" : ""}
              ${t.type === "info" ? "bg-sky-500/20 border-sky-500/30 text-sky-700 dark:text-sky-200" : ""}
            `}
          >
            {t.type === "success" && <Check size={14} />}
            {t.type === "error" && <X size={14} />}
            {t.type === "info" && <Sparkles size={14} />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

// ==================== Section Header ====================

function SectionHeader({
  icon: Icon,
  title,
  count,
  action,
}: {
  icon: React.ElementType;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] flex items-center justify-center">
          <Icon size={14} className="text-gray-700 dark:text-white/80" />
        </div>
        <span className="text-gray-800 dark:text-white/90 text-sm font-semibold">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-500/20">
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

// ==================== Confirm Dialog ====================

function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="relative w-full max-w-sm rounded-2xl bg-white/95 dark:bg-[#0b0b14]/95 backdrop-blur-2xl border border-black/[0.08] dark:border-white/[0.10] shadow-2xl overflow-hidden"
      >
        <div className="px-5 pt-4 pb-3 flex items-start gap-3">
          <div
            className={`w-9 h-9 rounded-xl shrink-0 flex items-center justify-center border ${
              danger
                ? "bg-red-500/15 border-red-500/25 text-red-500"
                : "bg-violet-500/15 border-violet-500/25 text-violet-500"
            }`}
          >
            <CircleAlert size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-800 dark:text-white/90">{title}</div>
            {description && (
              <div className="text-xs text-gray-600 dark:text-white/60 mt-1 leading-relaxed break-all">
                {description}
              </div>
            )}
          </div>
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-black/[0.05] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02]">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/80 text-sm"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`h-8 px-3 rounded-lg text-white text-sm font-medium flex items-center gap-1.5 ${
              danger
                ? "bg-red-500 hover:bg-red-600 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
                : "bg-violet-500 hover:bg-violet-600 shadow-[0_0_12px_rgba(139,92,246,0.35)]"
            }`}
          >
            {confirmText}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

// ==================== Custom Select ====================

interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

function Select({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  className,
  menuClassName,
  align = "start",
  title,
  compact = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  menuClassName?: string;
  align?: "start" | "end";
  title?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [openUp, setOpenUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);

  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const menuMaxH = 280;
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < menuMaxH + 16 && r.top > spaceBelow;
    setOpenUp(up);
    setRect({ top: up ? r.top : r.bottom, left: r.left, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    recompute();
    const onScroll = () => recompute();
    const onResize = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        menuRef.current?.contains(t)
      )
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, recompute]);

  const heightClass = compact ? "h-7" : "h-8";
  const textClass = compact ? "text-[11px]" : "text-xs";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        title={title}
        className={`${heightClass} ${textClass} px-2.5 pr-2 rounded-lg bg-white/80 dark:bg-white/5 border border-black/10 dark:border-white/15 text-gray-700 dark:text-white/80 hover:border-violet-400 dark:hover:border-violet-400/60 focus:border-violet-400 outline-none transition-colors flex items-center gap-1.5 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed ${
          open ? "border-violet-400 dark:border-violet-400/60 ring-2 ring-violet-400/20" : ""
        } ${className ?? ""}`}
      >
        <span className="flex-1 truncate text-left">
          {current ? current.label : <span className="text-gray-400 dark:text-white/40">{placeholder ?? "请选择"}</span>}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-gray-500 dark:text-white/50 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        rect &&
        typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: openUp ? 4 : -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: openUp ? 4 : -4, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 450, damping: 32 }}
              style={{
                position: "fixed",
                top: openUp ? undefined : rect.top + 4,
                bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
                left: align === "end" ? undefined : rect.left,
                right:
                  align === "end"
                    ? window.innerWidth - (rect.left + rect.width)
                    : undefined,
                minWidth: Math.max(rect.width, 160),
              }}
              className={`z-[200] max-h-[280px] overflow-auto rounded-xl bg-white/95 dark:bg-[#14141f]/95 backdrop-blur-xl border border-black/[0.08] dark:border-white/[0.10] shadow-[0_10px_40px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_40px_rgba(0,0,0,0.6)] p-1 ${
                menuClassName ?? ""
              }`}
            >
              {options.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400 dark:text-white/40">
                  无选项
                </div>
              ) : (
                options.map((opt) => {
                  const active = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-left transition-colors ${
                        active
                          ? "bg-violet-500/15 text-violet-700 dark:text-violet-200"
                          : "text-gray-700 dark:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                      }`}
                    >
                      <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                      {opt.hint && (
                        <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/40">
                          {opt.hint}
                        </span>
                      )}
                      {active && (
                        <Check
                          size={12}
                          strokeWidth={3}
                          className="shrink-0 text-violet-500 dark:text-violet-300"
                        />
                      )}
                    </button>
                  );
                })
              )}
            </motion.div>
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

// ==================== 折叠栏：工作区干净 / 跳过检测 ====================

const SKIP_KIND_META: Record<
  SkipKind,
  { label: string; icon: React.ElementType; className: string }
> = {
  manual: {
    label: "手动跳过",
    icon: EyeOff,
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/20",
  },
  dir: {
    label: "文件夹",
    icon: Folder,
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/20",
  },
  file: {
    label: "文件",
    icon: FileIcon,
    className: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/20",
  },
  ignored: {
    label: "已忽略",
    icon: FolderX,
    className: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/20",
  },
};

const SKIP_KIND_ORDER: SkipKind[] = ["manual", "dir", "file", "ignored"];

/** 可折叠的次级列表容器 */
function CollapsibleSection({
  icon: Icon,
  title,
  hint,
  count,
  accent,
  open,
  onToggle,
  action,
  children,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
  count: number;
  accent: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl border border-black/[0.08] dark:border-white/[0.10] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2.5 mr-auto min-w-0 text-left"
        >
          <div
            className={`w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center ${accent}`}
          >
            <Icon size={14} />
          </div>
          <span className="text-gray-800 dark:text-white/90 text-sm font-semibold shrink-0">
            {title}
          </span>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-black/[0.05] dark:bg-white/[0.08] text-gray-600 dark:text-white/60 shrink-0">
            {count}
          </span>
          {hint && (
            <span className="text-[11px] text-gray-400 dark:text-white/40 truncate hidden sm:inline">
              {hint}
            </span>
          )}
        </button>
        {action}
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/70 flex items-center justify-center"
          title={open ? "收起" : "展开"}
        >
          <motion.span
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center justify-center"
          >
            <ChevronDown size={13} />
          </motion.span>
        </button>
      </div>
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={{
          height: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
          opacity: { duration: 0.18, delay: open ? 0.06 : 0 },
        }}
        style={{ overflow: "hidden" }}
      >
        <div className="border-t border-black/[0.06] dark:border-white/[0.08] p-2 max-h-80 overflow-auto">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

/** 工作区干净的项目行 */
function CleanRow({
  path,
  status,
  checking,
  onCheck,
  onSkip,
}: {
  path: string;
  status?: GitStatus;
  checking: boolean;
  onCheck: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="group flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <div className="w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/20">
        <FolderCheck size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-gray-800 dark:text-white/85 truncate">
            {getRepoName(path)}
          </span>
          {status?.branch && (
            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/20">
              <GitBranch size={9} />
              {status.branch}
            </span>
          )}
          {status && status.ahead > 0 && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20">
              ↑{status.ahead} 待推送
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-gray-400 dark:text-white/40 truncate" title={path}>
          {path}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="h-7 px-2 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-300 border border-sky-500/20 text-[11px] flex items-center gap-1 disabled:opacity-50"
          title="重新检测该项目"
        >
          <RefreshCw size={11} className={checking ? "animate-spin" : undefined} />
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="h-7 px-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/60 text-[11px] flex items-center gap-1"
          title="加入跳过检测"
        >
          <EyeOff size={11} />
        </button>
      </div>
    </div>
  );
}

/** 跳过检测清单里的行 */
function SkipRow({ item, onRestore }: { item: SkipItem; onRestore: () => void }) {
  const meta = SKIP_KIND_META[item.kind] ?? SKIP_KIND_META.ignored;
  const Icon = meta.icon;
  return (
    <div className="group flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <div className={`w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center ${meta.className}`}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-gray-800 dark:text-white/85 truncate">
          {item.name || getRepoName(item.path)}
        </div>
        <div className="text-[10.5px] text-gray-400 dark:text-white/40 truncate" title={item.path}>
          {item.path}
        </div>
      </div>
      <span className="shrink-0 text-[10.5px] text-gray-500 dark:text-white/50 hidden sm:inline">
        {item.reason}
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="shrink-0 h-7 px-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-sky-500/15 text-gray-600 dark:text-white/60 hover:text-sky-600 dark:hover:text-sky-300 text-[11px] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        title="恢复检测：下次检测会重新纳入"
      >
        <Eye size={11} /> 恢复
      </button>
    </div>
  );
}

// ==================== Draggable Repo Card（长按触发拖拽排序，兼容 Grid 布局） ====================

const LONG_PRESS_MS = 320;
const LONG_PRESS_MOVE_TOLERANCE = 6;

interface DraggableRepoCardProps extends Omit<RepoCardProps, "path" | "isDragging"> {
  value: string;
  allValues: string[];
  onReorder: (next: string[]) => void;
}

interface SlotRect {
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function DraggableRepoCard({ value, allValues, onReorder, ...cardProps }: DraggableRepoCardProps) {
  const dragControls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const allValuesRef = useRef(allValues);
  // 拖拽开始时一次性捕获的槽位；整个拖拽过程中作为稳定的参照系使用
  const slotsRef = useRef<SlotRect[]>([]);
  const lastTargetIdxRef = useRef<number>(-1);
  // 拖拽开始时的原始顺序快照；每次命中新目标都基于此做"直接互换"，
  // 从而保证其它卡片保持原位，不会因为鼠标路径产生连锁位移
  const originalListRef = useRef<string[]>([]);

  useEffect(() => {
    allValuesRef.current = allValues;
  }, [allValues]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const captureSlots = () => {
    const cards = document.querySelectorAll<HTMLElement>("[data-repo-path]");
    const rects: SlotRect[] = [];
    cards.forEach((el) => {
      const p = el.dataset.repoPath;
      if (!p) return;
      const r = el.getBoundingClientRect();
      rects.push({ value: p, x: r.left, y: r.top, w: r.width, h: r.height });
    });
    slotsRef.current = rects;
    lastTargetIdxRef.current = rects.findIndex((s) => s.value === value);
    originalListRef.current = [...allValuesRef.current];
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return;

    const target = e.target as HTMLElement | null;

    // 显式拖拽把手：按下即刻进入拖拽，不需要长按
    if (target && target.closest("[data-drag-handle]")) {
      e.preventDefault();
      captureSlots();
      setIsDragging(true);
      try {
        dragControls.start(e);
      } catch {
        /* ignore */
      }
      return;
    }

    if (
      target &&
      target.closest(
        'button, a, input, textarea, select, [role="button"], [data-no-drag], [contenteditable="true"]',
      )
    ) {
      return;
    }

    pressOriginRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimer.current = window.setTimeout(() => {
      captureSlots();
      setIsDragging(true);
      try {
        dragControls.start(e);
      } catch {
        /* ignore */
      }
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const origin = pressOriginRef.current;
    if (!origin || longPressTimer.current === null) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE * LONG_PRESS_MOVE_TOLERANCE) {
      clearLongPressTimer();
    }
  };

  const handlePointerEndOrCancel = () => {
    clearLongPressTimer();
    pressOriginRef.current = null;
  };

  // 拖拽过程中：基于拖拽开始时捕获的稳定"槽位几何"做带死区的命中检测
  // - 命中检测不会读取正在动画中的实时 rect，避免反馈回路造成的抽搐
  // - 只有指针进入目标槽位内 ~70% 的核心区域时才触发交换，避免边界来回抖动
  const handleDrag = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const slots = slotsRef.current;
      if (slots.length === 0) return;
      const px = info.point.x;
      const py = info.point.y;
      // 取占槽位核心区域的 70%，作为触发区，外围 15% 为死区
      const INSET_RATIO = 0.15;
      let targetSlotIdx = -1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const ix = s.w * INSET_RATIO;
        const iy = s.h * INSET_RATIO;
        if (
          px >= s.x + ix &&
          px <= s.x + s.w - ix &&
          py >= s.y + iy &&
          py <= s.y + s.h - iy
        ) {
          targetSlotIdx = i;
          break;
        }
      }
      if (targetSlotIdx === -1) return;
      if (targetSlotIdx === lastTargetIdxRef.current) return;

      // 基于拖拽开始时的"原始顺序"做直接互换：
      // 无论指针从哪里划过来，当前数组始终 = 原始数组把 E 与目标槽位原占位者对调，
      // 其他卡片始终停留在自己的原始位置，不会被波及
      const original = originalListRef.current;
      if (original.length === 0) return;
      const originalFromIdx = original.indexOf(value);
      if (originalFromIdx === -1) return;

      lastTargetIdxRef.current = targetSlotIdx;

      if (targetSlotIdx === originalFromIdx) {
        // 回到自己的起点：直接还原成原始顺序
        onReorder([...original]);
        return;
      }

      const next = [...original];
      const tmp = next[originalFromIdx];
      next[originalFromIdx] = next[targetSlotIdx];
      next[targetSlotIdx] = tmp;
      onReorder(next);
    },
    [value, onReorder],
  );

  useEffect(() => {
    return () => {
      clearLongPressTimer();
    };
  }, [clearLongPressTimer]);

  return (
    <motion.div
      data-repo-path={value}
      // 只动位置：网格行高变化时不去动画宽高，避免留下空白格子
      layout="position"
      drag={isDragging ? true : false}
      dragControls={dragControls}
      dragListener={false}
      dragSnapToOrigin
      dragElastic={0}
      dragMomentum={false}
      onDrag={handleDrag}
      onDragEnd={() => {
        setIsDragging(false);
        slotsRef.current = [];
        lastTargetIdxRef.current = -1;
        originalListRef.current = [];
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEndOrCancel}
      onPointerCancel={handlePointerEndOrCancel}
      animate={{
        scale: isDragging ? 1.02 : 1,
        zIndex: isDragging ? 40 : 0,
      }}
      transition={{
        layout: { type: "spring", stiffness: 420, damping: 38 },
        scale: { type: "spring", stiffness: 420, damping: 34 },
      }}
      style={{
        touchAction: "none",
        position: "relative",
        borderRadius: "1rem",
      }}
    >
      <RepoCard
        {...(cardProps as RepoCardProps)}
        path={value}
        isDragging={isDragging}
      />
    </motion.div>
  );
}

// ==================== Repo Card ====================

interface RepoCardProps {
  path: string;
  status?: GitStatus;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSkip: () => void;
  onCheck: () => void;
  onRun: () => void;
  onCancel: () => void;
  checking: boolean;
  running: boolean;
  presets: CommitPreset[];
  presetId: string;
  onPresetChange: (id: string) => void;
  message: string;
  onMessageChange: (msg: string) => void;
  messageError?: boolean;
  logs: string[];
  onClearLogs: () => void;
  /** 上次一键提交的失败/取消结果，有值时卡片会保留在待提交栏并显示失败态 */
  outcome?: RunOutcome;
  onDismissOutcome: () => void;
  isDragging?: boolean;
}

function RepoCard({
  path,
  status,
  selected,
  onToggle,
  onRemove,
  onSkip,
  onCheck,
  onRun,
  onCancel,
  checking,
  running,
  presets,
  presetId,
  onPresetChange,
  message,
  onMessageChange,
  messageError,
  logs,
  onClearLogs,
  outcome,
  onDismissOutcome,
  isDragging = false,
}: RepoCardProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const wasCheckingRef = useRef(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (messageError && messageRef.current) {
      messageRef.current.focus();
      messageRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [messageError]);
  const name = useMemo(() => getRepoName(path), [path]);

  const totalChanges = status
    ? status.modified + status.added + status.deleted + status.renamed + status.untracked + status.conflicted
    : 0;

  const hasError = !!status?.error || (status && !status.is_repo);
  const hasChanges = !!status && status.is_repo && totalChanges > 0;
  const runFailed = !running && outcome?.status === "failed";
  const runCancelled = !running && outcome?.status === "cancelled";

  useEffect(() => {
    if (running && logs.length > 0) setLogExpanded(true);
  }, [running, logs.length]);

  // 失败后自动把执行日志展开，方便直接看到出错的那一步
  useEffect(() => {
    if (runFailed) setLogExpanded(true);
  }, [runFailed, outcome?.at]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // 检测完成后：有改动则自动展开文件详情，无改动则自动收起
  useEffect(() => {
    if (wasCheckingRef.current && !checking) {
      if (hasChanges) setFilesExpanded(true);
      else setFilesExpanded(false);
    }
    wasCheckingRef.current = checking;
  }, [checking, hasChanges]);

  const activePreset = presets.find((p) => p.id === presetId) ?? presets[0];
  const enabledStepCount = activePreset?.steps.filter((s) => s.enabled).length ?? 0;

  // 每个项目一个独立颜色（基于路径哈希），保证重进入也稳定
  const projectAccent = useMemo(() => pickProjectAccent(path), [path]);
  // 状态优先级：运行中 / 错误 覆盖项目色，其它情况使用项目色
  const accentColor = running
    ? "from-emerald-500 to-teal-500"
    : hasError || runFailed
    ? "from-rose-500 to-red-500"
    : runCancelled
    ? "from-amber-500 to-orange-500"
    : projectAccent;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
      }}
      whileHover={isDragging ? undefined : { y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className={`group relative rounded-2xl overflow-hidden flex flex-col select-none
        backdrop-blur-2xl backdrop-saturate-150
        transition-[background-color,box-shadow] duration-300 ease-out
        bg-white/60 dark:bg-white/[0.035]
        shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_0_0_1px_rgba(255,255,255,0.15)]
        dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(255,255,255,0.035)]
        ${isDragging
          ? "cursor-grabbing shadow-[0_24px_60px_-16px_rgba(15,23,42,0.45),0_0_0_2px_rgba(139,92,246,0.5)] dark:shadow-[0_24px_60px_-16px_rgba(0,0,0,0.7),0_0_0_2px_rgba(139,92,246,0.55)]"
          : "hover:shadow-[0_18px_40px_-14px_rgba(15,23,42,0.22),inset_0_1px_0_rgba(255,255,255,0.6),inset_0_0_0_1px_rgba(255,255,255,0.2)] dark:hover:shadow-[0_18px_40px_-14px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.06)]"}
        ${running ? "ring-1 ring-emerald-400/40 dark:ring-emerald-400/30" : ""}
        ${runFailed ? "ring-1 ring-rose-400/50 dark:ring-rose-400/40" : ""}
        ${runCancelled ? "ring-1 ring-amber-400/45 dark:ring-amber-400/35" : ""}
      `}
    >
      {/* 玻璃层 1：左上角镜面高光（模拟光线折射） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%)",
          mixBlendMode: "overlay",
        }}
      />

      {/* 玻璃层 2：整体柔和渐变（顶部更亮，底部更沉） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 35%, rgba(0,0,0,0.04) 100%)",
        }}
      />

      {/* 悬浮时的彩色光晕（使用项目色） */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-br ${projectAccent}`}
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.22), rgba(0,0,0,0) 55%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.22), rgba(0,0,0,0) 55%)",
          mixBlendMode: "soft-light",
        }}
      />

      {/* 选中态动画层：紫色渐变底 + 光环 */}
      <motion.div
        aria-hidden
        initial={false}
        animate={{
          opacity: selected ? 1 : 0,
          scale: selected ? 1 : 0.985,
        }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            "linear-gradient(180deg, rgba(139,92,246,0.14) 0%, rgba(139,92,246,0.04) 50%, rgba(99,102,241,0.06) 100%)",
          boxShadow:
            "inset 0 0 0 1.5px rgba(139,92,246,0.55), 0 0 0 3px rgba(139,92,246,0.12), 0 10px 28px -10px rgba(139,92,246,0.35)",
        }}
      />

      {/* 选中瞬间的涟漪（仅在勾选时触发一次） */}
      <AnimatePresence>
        {selected && (
          <motion.div
            aria-hidden
            key="select-ripple"
            initial={{ opacity: 0.55, scale: 0 }}
            animate={{ opacity: 0, scale: 3.2 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute top-2 left-2 w-10 h-10 rounded-full bg-violet-400/40 blur-2xl"
          />
        )}
      </AnimatePresence>

      {/* 顶部彩条 */}
      <div className={`h-[3px] w-full bg-gradient-to-r ${accentColor} relative z-[1]`} />

      {/* 头部 */}
      <div className="flex items-start gap-3 p-3.5 pb-2.5">
        <motion.button
          type="button"
          onClick={onToggle}
          whileTap={{ scale: 0.88 }}
          animate={{
            scale: selected ? [1, 1.22, 1] : 1,
          }}
          transition={{ duration: 0.32, ease: [0.34, 1.56, 0.64, 1] }}
          className={`relative z-[2] shrink-0 mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center transition-[background-color,border-color,box-shadow] duration-200
            ${selected
              ? "bg-violet-500 border-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.55)]"
              : "bg-white/80 dark:bg-white/10 border-black/15 dark:border-white/25 hover:border-violet-400"}
          `}
          title={selected ? "取消批量选中" : "批量选中"}
        >
          <AnimatePresence initial={false}>
            {selected && (
              <motion.span
                key="check"
                initial={{ scale: 0, rotate: -25, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 22 }}
                className="flex items-center justify-center"
              >
                <Check size={12} className="text-white" strokeWidth={3} />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-gray-800 dark:text-white/90 truncate max-w-full">
              {name}
            </span>
            {status?.branch && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/20">
                <GitBranch size={10} />
                {status.branch}
              </span>
            )}
            {status && status.ahead > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20">
                ↑{status.ahead}
              </span>
            )}
            {status && status.behind > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/20">
                ↓{status.behind}
              </span>
            )}
            {running && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20">
                <RefreshCw size={10} className="animate-spin" />
                执行中
              </span>
            )}
            {runFailed && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/25">
                <CircleAlert size={10} />
                提交失败
              </span>
            )}
            {runCancelled && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/25">
                <Square size={10} />
                已取消
              </span>
            )}
          </div>
          <div
            className="text-[11px] text-gray-500 dark:text-white/50 truncate mt-0.5"
            title={path}
          >
            {path}
          </div>
        </div>

        <div
          data-drag-handle
          role="button"
          aria-label="拖拽排序"
          className="shrink-0 w-5 h-7 flex items-center justify-center text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/70 opacity-0 group-hover:opacity-100 transition-all cursor-grab active:cursor-grabbing select-none touch-none"
          title="按住并拖拽以排序"
        >
          <GripVertical size={14} />
        </div>

        <button
          type="button"
          onClick={onSkip}
          disabled={running}
          className="shrink-0 w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-violet-500/20 text-gray-500 dark:text-white/60 hover:text-violet-500 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="跳过检测：移入跳过清单，之后每次检测都忽略它"
        >
          <EyeOff size={13} />
        </button>

        <button
          type="button"
          onClick={onRemove}
          disabled={running}
          className="shrink-0 w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/20 text-gray-500 dark:text-white/60 hover:text-red-500 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="移出监控列表（不删除本地文件）"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* 变更统计 */}
      <div className="px-3.5 pb-2">
        {status && status.is_repo ? (
          <div className="flex flex-wrap items-center gap-1.5 min-h-[22px]">
            {status.modified > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/20">
                M {status.modified}
              </span>
            )}
            {status.added > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20">
                A {status.added}
              </span>
            )}
            {status.deleted > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-rose-500/15 text-rose-500 dark:text-rose-300 border border-rose-500/20">
                D {status.deleted}
              </span>
            )}
            {status.renamed > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-indigo-500/15 text-indigo-500 dark:text-indigo-300 border border-indigo-500/20">
                R {status.renamed}
              </span>
            )}
            {status.untracked > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-slate-500/15 text-slate-600 dark:text-slate-300 border border-slate-500/20">
                ? {status.untracked}
              </span>
            )}
            {status.conflicted > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-red-500/15 text-red-500 dark:text-red-300 border border-red-500/20">
                U {status.conflicted}
              </span>
            )}
            {!hasChanges && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/15">
                ✓ 工作区干净
              </span>
            )}
            {hasChanges && (
              <button
                type="button"
                onClick={() => setFilesExpanded((v) => !v)}
                className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-gray-500 dark:text-white/50 hover:text-violet-500"
              >
                {filesExpanded ? "收起" : `详情 (${totalChanges})`}
                <ChevronRight
                  size={11}
                  className={`transition-transform ${filesExpanded ? "rotate-90" : ""}`}
                />
              </button>
            )}
          </div>
        ) : hasError ? (
          <div className="flex items-center gap-1 text-[11px] text-red-500 dark:text-red-300 min-h-[22px]">
            <CircleAlert size={11} />
            {status?.error || "不是 git 仓库"}
          </div>
        ) : checking ? (
          <div className="flex items-center gap-1 text-[11px] text-violet-500 dark:text-violet-300 min-h-[22px]">
            <RefreshCw size={11} className="animate-spin" />
            正在检测...
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-white/40 min-h-[22px]">
            <ScanLine size={11} />
            尚未检测，请点击"检测修改"
          </div>
        )}
      </div>

      {/* 上次执行失败 / 被取消：卡片保留在待提交栏，并把原因摆在显眼位置 */}
      <AnimatePresence initial={false}>
        {outcome && !running && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mx-3.5 mb-2 overflow-hidden"
          >
            <div
              className={`rounded-xl border p-2.5 ${
                runFailed
                  ? "bg-rose-500/10 border-rose-500/25"
                  : "bg-amber-500/10 border-amber-500/25"
              }`}
            >
              <div className="flex items-start gap-2">
                <div
                  className={`shrink-0 mt-0.5 ${
                    runFailed ? "text-rose-500 dark:text-rose-300" : "text-amber-500 dark:text-amber-300"
                  }`}
                >
                  {runFailed ? <CircleAlert size={13} /> : <Square size={13} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-[11.5px] font-semibold ${
                      runFailed
                        ? "text-rose-600 dark:text-rose-300"
                        : "text-amber-600 dark:text-amber-300"
                    }`}
                  >
                    {runFailed ? "上次一键提交失败" : "上次任务被取消"}
                    <span className="ml-1.5 font-normal text-gray-500 dark:text-white/50">
                      {formatOutcomeTime(outcome.at)}
                      {outcome.presetName ? ` · ${outcome.presetName}` : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-700 dark:text-white/70 break-words">
                    {outcome.reason}
                  </div>
                  {runFailed && !hasChanges && (
                    <div className="mt-1 text-[10.5px] text-gray-500 dark:text-white/50">
                      工作区已经干净，改动可能已提交到本地，只是后面的步骤（如推送）没成功
                    </div>
                  )}
                  {outcome.detail.length > 0 && (
                    <div className="mt-1.5 max-h-20 overflow-auto rounded-lg bg-black/[0.05] dark:bg-black/40 px-2 py-1.5 text-[10.5px] font-mono leading-relaxed text-gray-600 dark:text-white/60 whitespace-pre-wrap">
                      {outcome.detail.map((l, i) => (
                        <div key={i}>{l}</div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onDismissOutcome}
                  className="shrink-0 w-6 h-6 rounded-lg text-gray-500 dark:text-white/50 hover:bg-black/[0.06] dark:hover:bg-white/[0.10] flex items-center justify-center"
                  title="清除失败标记（不影响本地文件；工作区干净的话卡片会回到「工作区干净」栏）"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 文件列表（可折叠） */}
      <AnimatePresence initial={false}>
        {filesExpanded && status && status.files.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mx-3.5 mb-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.06] overflow-hidden"
          >
            <div className="max-h-36 overflow-auto p-2 space-y-1">
              {status.files.slice(0, 200).map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
                  <span
                    className={`inline-flex items-center justify-center shrink-0 w-6 px-1 py-0.5 rounded border text-[10px] font-bold ${statusBadgeColor(f.status)}`}
                  >
                    {f.status.trim() || "??"}
                  </span>
                  <span
                    className="text-gray-700 dark:text-white/70 truncate"
                    title={f.path}
                  >
                    {f.path}
                  </span>
                </div>
              ))}
              {status.files.length > 200 && (
                <div className="text-[11px] text-gray-500 dark:text-white/50 pt-1">
                  ... 另有 {status.files.length - 200} 个文件未显示
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 配置区：提交备注 + 预设 */}
      <div className="px-3.5 pb-2.5 space-y-2">
        <motion.textarea
          ref={messageRef}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          disabled={running}
          placeholder='提交备注（必填，用于 {{message}} 占位符）'
          rows={1}
          animate={messageError ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
          transition={{ duration: 0.4 }}
          className={`w-full px-2.5 py-1.5 rounded-md bg-white/80 dark:bg-white/5 border text-[12px] outline-none resize-y min-h-[30px] max-h-20 disabled:opacity-50 transition-colors
            ${messageError
              ? "border-red-500 dark:border-red-400 focus:border-red-500 ring-2 ring-red-500/20 dark:ring-red-400/25 bg-red-50/60 dark:bg-red-500/10 placeholder-red-400 dark:placeholder-red-300/70"
              : "border-black/10 dark:border-white/15 focus:border-violet-400"}
          `}
        />

        <div className="flex items-center gap-1.5">
          <ListTree size={12} className="text-gray-500 dark:text-white/50 shrink-0" />
          <Select
            value={presetId}
            onChange={onPresetChange}
            disabled={running}
            compact
            className="flex-1 min-w-0"
            title="为该项目选择要执行的命令预设"
            options={presets.map((p) => ({
              value: p.id,
              label: p.name,
              hint: `${p.steps.filter((s) => s.enabled).length} 步`,
            }))}
          />
          <span className="text-[10px] text-gray-500 dark:text-white/50 shrink-0">
            {enabledStepCount} 步
          </span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="mt-auto px-3.5 pb-3 pt-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || running}
          className="flex-1 h-8 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 text-sky-600 dark:text-sky-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="仅检测该目录的 git 改动"
        >
          <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
          检测修改
        </button>

        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 h-8 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/25 text-red-600 dark:text-red-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            title="取消当前任务"
          >
            <Square size={12} /> 取消
          </button>
        ) : (
          <button
            type="button"
            onClick={onRun}
            disabled={enabledStepCount === 0 || checking}
            className={`flex-[1.2] h-8 rounded-lg text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-all
              ${runFailed
                ? "bg-gradient-to-r from-rose-500 to-red-500 hover:from-rose-600 hover:to-red-600 shadow-[0_0_12px_rgba(244,63,94,0.35)]"
                : "bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 shadow-[0_0_12px_rgba(139,92,246,0.35)]"}
            `}
            title={runFailed ? "重新按预设命令顺序执行一次" : "按预设命令顺序执行：一键提交 git"}
          >
            <Rocket size={12} /> {runFailed ? "重试提交" : "一键提交"}
          </button>
        )}
      </div>

      {/* 该仓库的运行日志 */}
      <AnimatePresence initial={false}>
        {logs.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-black/[0.06] dark:border-white/[0.06] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setLogExpanded((v) => !v)}
              className="w-full px-3.5 py-1.5 flex items-center justify-between text-[11px] text-gray-600 dark:text-white/60 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
            >
              <span className="inline-flex items-center gap-1.5">
                <Terminal size={11} />
                执行日志 ({logs.length})
                {running && (
                  <RefreshCw size={10} className="animate-spin text-emerald-500" />
                )}
              </span>
              <span className="inline-flex items-center gap-1">
                {!running && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearLogs();
                    }}
                    className="px-1.5 py-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-gray-500 dark:text-white/60"
                    title="清空该仓库日志"
                  >
                    <Eraser size={11} />
                  </span>
                )}
                <ChevronDown
                  size={12}
                  className={`transition-transform ${logExpanded ? "rotate-180" : ""}`}
                />
              </span>
            </button>
            <AnimatePresence initial={false}>
              {logExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                >
                  <div
                    ref={logRef}
                    className="max-h-48 overflow-auto px-3 pb-3 pt-1 text-[11px] font-mono leading-relaxed bg-gray-950/95 dark:bg-black/60 whitespace-pre-wrap"
                  >
                    {logs.map((l, i) => {
                      let color = "text-gray-200";
                      if (l.includes("✓")) color = "text-emerald-400";
                      else if (l.includes("✗")) color = "text-red-400";
                      else if (l.includes("↷")) color = "text-amber-400";
                      else if (l.startsWith("▶")) color = "text-sky-300";
                      else if (l.includes("━━━")) color = "text-violet-300 font-semibold";
                      else if (l.includes("🎉")) color = "text-emerald-300 font-semibold";
                      return (
                        <div key={i} className={color}>
                          {l || "\u00A0"}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ==================== Preset Editor ====================

function PresetEditor({
  open: isOpen,
  onClose,
  config,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  config: PipelineConfig;
  onSave: (cfg: PipelineConfig) => void;
}) {
  const [draft, setDraft] = useState<PipelineConfig>(config);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    if (isOpen) setDraft(JSON.parse(JSON.stringify(config)));
  }, [isOpen, config]);

  const active = draft.presets.find((p) => p.id === draft.activePresetId) ?? draft.presets[0];

  const updateActive = (updater: (p: CommitPreset) => CommitPreset) => {
    setDraft((d) => ({
      ...d,
      presets: d.presets.map((p) => (p.id === active.id ? updater(p) : p)),
    }));
  };

  const updateStep = (stepId: string, patch: Partial<CommandStep>) => {
    updateActive((p) => ({
      ...p,
      steps: p.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
  };

  const removeStep = (stepId: string) => {
    updateActive((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== stepId) }));
  };

  const moveStep = (stepId: string, dir: -1 | 1) => {
    updateActive((p) => {
      const idx = p.steps.findIndex((s) => s.id === stepId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= p.steps.length) return p;
      const steps = [...p.steps];
      [steps[idx], steps[target]] = [steps[target], steps[idx]];
      return { ...p, steps };
    });
  };

  const addStep = () => {
    updateActive((p) => ({
      ...p,
      steps: [
        ...p.steps,
        {
          id: genId(),
          name: "新步骤",
          command: "",
          enabled: true,
          continueOnError: false,
          allowEmptyCommit: false,
        },
      ],
    }));
  };

  const addPreset = () => {
    const newId = genId();
    setDraft((d) => ({
      ...d,
      activePresetId: newId,
      presets: [
        ...d.presets,
        {
          id: newId,
          name: `预设 ${d.presets.length + 1}`,
          steps: [],
        },
      ],
    }));
  };

  const duplicatePreset = () => {
    const newId = genId();
    setDraft((d) => {
      const src = d.presets.find((p) => p.id === d.activePresetId);
      if (!src) return d;
      return {
        ...d,
        activePresetId: newId,
        presets: [
          ...d.presets,
          {
            id: newId,
            name: `${src.name} 副本`,
            steps: src.steps.map((s) => ({ ...s, id: genId() })),
          },
        ],
      };
    });
  };

  const removePreset = () => {
    if (draft.presets.length <= 1) return;
    setDraft((d) => {
      const remaining = d.presets.filter((p) => p.id !== d.activePresetId);
      return {
        ...d,
        activePresetId: remaining[0].id,
        presets: remaining,
      };
    });
  };

  const startRename = () => {
    if (!active) return;
    setRenamingId(active.id);
    setRenameValue(active.name);
  };

  const commitRename = () => {
    if (renamingId) {
      setDraft((d) => ({
        ...d,
        presets: d.presets.map((p) => (p.id === renamingId ? { ...p, name: renameValue || p.name } : p)),
      }));
    }
    setRenamingId(null);
  };

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="relative w-full max-w-4xl max-h-[90vh] rounded-2xl bg-white/95 dark:bg-[#0b0b14]/95 backdrop-blur-2xl border border-black/[0.08] dark:border-white/[0.10] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
              <Settings2 size={16} className="text-violet-500" />
            </div>
            <div>
              <div className="text-base font-semibold text-gray-800 dark:text-white/90">Pipeline 配置</div>
              <div className="text-xs text-gray-500 dark:text-white/50">
                自定义一键提交的命令和顺序（支持多条连续命令）
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] flex items-center justify-center text-gray-600 dark:text-white/70"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex">
          {/* Preset sidebar */}
          <div className="w-48 shrink-0 border-r border-black/[0.06] dark:border-white/[0.06] flex flex-col">
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-white/50">
              预设
            </div>
            <div className="flex-1 overflow-auto px-2 space-y-1">
              {draft.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, activePresetId: p.id }))}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors truncate
                    ${p.id === draft.activePresetId
                      ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/25"
                      : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-gray-700 dark:text-white/70 border border-transparent"}
                  `}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="p-2 border-t border-black/[0.06] dark:border-white/[0.06] flex gap-1">
              <button
                type="button"
                onClick={addPreset}
                className="flex-1 h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-violet-500/15 text-gray-700 dark:text-white/70 hover:text-violet-600 dark:hover:text-violet-300 text-xs flex items-center justify-center gap-1"
                title="新增预设"
              >
                <Plus size={12} /> 新增
              </button>
              <button
                type="button"
                onClick={duplicatePreset}
                className="flex-1 h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-sky-500/15 text-gray-700 dark:text-white/70 hover:text-sky-600 dark:hover:text-sky-300 text-xs flex items-center justify-center gap-1"
                title="复制当前预设"
              >
                <Copy size={12} /> 复制
              </button>
            </div>
          </div>

          {/* Active preset */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-5 py-3 border-b border-black/[0.06] dark:border-white/[0.06] flex items-center gap-2">
              {renamingId === active?.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 h-8 px-2 rounded-md bg-white dark:bg-white/5 border border-violet-400 text-sm outline-none"
                />
              ) : (
                <>
                  <div className="flex-1 text-sm font-semibold text-gray-800 dark:text-white/90">{active?.name}</div>
                  <button
                    type="button"
                    onClick={startRename}
                    className="w-7 h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/70 flex items-center justify-center"
                    title="重命名"
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={removePreset}
                disabled={draft.presets.length <= 1}
                className="w-7 h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/15 text-gray-600 dark:text-white/70 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                title="删除预设"
              >
                <Trash2 size={12} />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-2">
              {active?.steps.map((step, idx) => (
                <div
                  key={step.id}
                  className="rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-white/60 dark:bg-white/[0.03] p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-gray-500 dark:text-white/60 text-[11px] font-semibold flex items-center justify-center">
                      {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateStep(step.id, { enabled: !step.enabled })}
                      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors
                        ${step.enabled
                          ? "bg-violet-500 border-violet-500"
                          : "bg-white dark:bg-white/5 border-black/20 dark:border-white/25"}
                      `}
                      title={step.enabled ? "已启用" : "已禁用"}
                    >
                      {step.enabled && <Check size={10} className="text-white" strokeWidth={3} />}
                    </button>
                    <input
                      value={step.name}
                      onChange={(e) => updateStep(step.id, { name: e.target.value })}
                      placeholder="步骤名称"
                      className="flex-1 h-7 px-2 rounded-md bg-white dark:bg-white/5 border border-black/10 dark:border-white/15 text-[13px] outline-none focus:border-violet-400"
                    />
                    <button
                      type="button"
                      onClick={() => moveStep(step.id, -1)}
                      disabled={idx === 0}
                      className="w-6 h-6 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/70 flex items-center justify-center disabled:opacity-30"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveStep(step.id, 1)}
                      disabled={idx === (active?.steps.length ?? 1) - 1}
                      className="w-6 h-6 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/70 flex items-center justify-center disabled:opacity-30"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeStep(step.id)}
                      className="w-6 h-6 rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/20 text-gray-600 dark:text-white/70 hover:text-red-500 flex items-center justify-center"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  <input
                    value={step.command}
                    onChange={(e) => updateStep(step.id, { command: e.target.value })}
                    placeholder={'命令，例如 git commit -m "{{message}}"'}
                    spellCheck={false}
                    className="w-full h-8 px-2.5 rounded-md bg-gray-50 dark:bg-black/30 border border-black/10 dark:border-white/15 text-[12px] font-mono outline-none focus:border-violet-400"
                  />

                  <div className="flex items-center gap-4 pl-1">
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-white/60 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={step.continueOnError}
                        onChange={(e) => updateStep(step.id, { continueOnError: e.target.checked })}
                        className="accent-violet-500"
                      />
                      失败时继续后续步骤
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-white/60 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={step.allowEmptyCommit}
                        onChange={(e) => updateStep(step.id, { allowEmptyCommit: e.target.checked })}
                        className="accent-violet-500"
                      />
                      无改动时视为跳过（commit 步骤建议开启）
                    </label>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addStep}
                className="w-full h-9 rounded-xl border border-dashed border-black/15 dark:border-white/20 hover:border-violet-400 text-gray-600 dark:text-white/60 hover:text-violet-500 text-xs flex items-center justify-center gap-1.5 transition-colors"
              >
                <Plus size={13} /> 新增步骤
              </button>

              <div className="text-[11px] text-gray-500 dark:text-white/50 pt-2 leading-relaxed">
                支持占位符：
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{message}}"}</code>
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{branch}}"}</code>
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{repoName}}"}</code>
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{date}}"}</code>
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{time}}"}</code>
                <code className="mx-1 px-1 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.08]">{"{{user}}"}</code>
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600 dark:text-white/60">仓库出错时：</span>
            <Select
              compact
              value={draft.onRepoError}
              onChange={(v) =>
                setDraft((d) => ({ ...d, onRepoError: v as PipelineConfig["onRepoError"] }))
              }
              options={[
                { value: "stop-all", label: "整体中止" },
                { value: "skip-repo", label: "跳过该仓库继续下一个" },
                { value: "continue", label: "继续执行（仓库内部也尽量继续）" },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/80 text-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                onSave(draft);
                onClose();
              }}
              className="h-8 px-3 rounded-lg bg-violet-500 hover:bg-violet-600 text-white text-sm flex items-center gap-1.5 shadow-[0_0_12px_rgba(139,92,246,0.35)]"
            >
              <Save size={13} /> 保存
            </button>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

// ==================== Main Page ====================

export default function GitPipeline() {
  const [repos, setRepos] = useState<string[]>(() => loadRepos());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, GitStatus>>(() => loadStatuses());
  const [repoMeta, setRepoMeta] = useState<Record<string, RepoMeta>>(() => loadRepoMeta());
  const [config, setConfig] = useState<PipelineConfig>(() => loadConfig());
  const [editorOpen, setEditorOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  /** 提交备注为空时临时标记的仓库（用于红色闪烁提示） */
  const [messageErrorRepos, setMessageErrorRepos] = useState<Set<string>>(new Set());

  /** 需要整体扫描的根目录（选一个父文件夹，自动找出里面所有 git 项目） */
  const [scanRoot, setScanRoot] = useState<string>(
    () => localStorage.getItem(SCAN_ROOT_KEY) ?? "",
  );
  /** 扫描的最大子目录层级 */
  const [scanDepth, setScanDepth] = useState<number>(() => loadScanDepth());
  /** 由扫描发现的项目（与手动添加的项目区分，便于重新扫描时替换） */
  const [scannedRepos, setScannedRepos] = useState<Set<string>>(
    () => new Set(loadStringList(SCANNED_REPOS_KEY)),
  );
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<{
    total: number;
    changed: number;
    truncated: boolean;
  } | null>(null);
  /**
   * 跳过检测清单：非文件夹、没有 git 关联的条目在首次检测后自动进入，
   * 也可以从卡片手动加入。只有"重新选择根目录"才会清空。
   */
  const [skipList, setSkipList] = useState<SkipItem[]>(() => loadSkipList());
  /** 两个次级折叠栏的展开状态 */
  const [sectionsOpen, setSectionsOpen] = useState<{ clean: boolean; skip: boolean }>(() => {
    try {
      const raw = localStorage.getItem(SECTIONS_OPEN_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return { clean: !!parsed?.clean, skip: !!parsed?.skip };
    } catch {
      return { clean: false, skip: false };
    }
  });

  const [chromeCollapsed, setChromeCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CHROME_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(CHROME_COLLAPSED_KEY, chromeCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [chromeCollapsed]);

  /** 一键提交失败/取消的仓库结果，用于把卡片留在待提交栏并显示失败原因 */
  const [runResults, setRunResults] = useState<Record<string, RunOutcome>>(() => loadRunResults());

  /** 每个仓库独立的运行态/检测态/session/日志 */
  const [runningRepos, setRunningRepos] = useState<Set<string>>(new Set());
  const [checkingRepos, setCheckingRepos] = useState<Set<string>>(new Set());
  const [repoSessions, setRepoSessions] = useState<Record<string, string>>({});
  const [repoLogs, setRepoLogs] = useState<Record<string, string[]>>({});

  /** 全局批量执行态 */
  const [batchRunning, setBatchRunning] = useState(false);
  const batchSessionRef = useRef<string>("");

  /** 删除确认框 */
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);

  const pushToast = useCallback((message: string, type: ToastData["type"] = "info") => {
    const id = ++toastCounter;
    setToasts((t) => [...t, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    saveRepos(repos);
  }, [repos]);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    saveRepoMeta(repoMeta);
  }, [repoMeta]);

  useEffect(() => {
    localStorage.setItem(SCAN_ROOT_KEY, scanRoot);
  }, [scanRoot]);

  useEffect(() => {
    saveStringList(SCANNED_REPOS_KEY, Array.from(scannedRepos));
  }, [scannedRepos]);

  useEffect(() => {
    localStorage.setItem(SCAN_DEPTH_KEY, String(scanDepth));
  }, [scanDepth]);

  useEffect(() => {
    localStorage.setItem(SKIP_LIST_KEY, JSON.stringify(skipList));
  }, [skipList]);

  useEffect(() => {
    localStorage.setItem(SECTIONS_OPEN_KEY, JSON.stringify(sectionsOpen));
  }, [sectionsOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(STATUSES_KEY, JSON.stringify(statuses));
    } catch {
      // 超出配额时放弃缓存，不影响功能
    }
  }, [statuses]);

  useEffect(() => {
    try {
      localStorage.setItem(RUN_RESULTS_KEY, JSON.stringify(runResults));
    } catch {
      /* ignore */
    }
  }, [runResults]);

  /** 清掉一批仓库的失败/取消标记 */
  const clearRunResults = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setRunResults((prev) => {
      const hit = paths.filter((p) => prev[p]);
      if (hit.length === 0) return prev;
      const next = { ...prev };
      hit.forEach((p) => delete next[p]);
      return next;
    });
  }, []);

  const skipPathSet = useMemo(() => new Set(skipList.map((s) => s.path)), [skipList]);

  /** 把一批条目加入跳过清单（按路径去重） */
  const addToSkipList = useCallback((items: SkipItem[]) => {
    if (items.length === 0) return;
    setSkipList((prev) => {
      const seen = new Set(prev.map((s) => s.path));
      const additions = items.filter((i) => !seen.has(i.path));
      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
  }, []);

  const getPresetId = useCallback(
    (path: string) => repoMeta[path]?.presetId ?? config.activePresetId,
    [repoMeta, config.activePresetId],
  );

  const getMessage = useCallback(
    (path: string) => repoMeta[path]?.lastMessage ?? "",
    [repoMeta],
  );

  const updateRepoMeta = useCallback((path: string, patch: Partial<RepoMeta>) => {
    setRepoMeta((prev) => ({
      ...prev,
      [path]: { ...prev[path], ...patch },
    }));
  }, []);

  const appendLog = useCallback((path: string, line: string) => {
    setRepoLogs((prev) => ({
      ...prev,
      [path]: [...(prev[path] ?? []), line],
    }));
  }, []);

  const resetLog = useCallback((path: string) => {
    setRepoLogs((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  /**
   * 卡片区：工作区不干净（或尚未检测）的项目。
   * 上次一键提交失败/被取消的项目也留在这里 —— 失败常发生在 commit 之后（比如 push 被拒），
   * 此时工作区已经干净，如果只按 git 状态归类，卡片会连同失败原因一起消失。
   */
  const visibleRepos = useMemo(
    () =>
      repos.filter(
        (p) => !skipPathSet.has(p) && (classifyRepo(statuses[p]) === "dirty" || !!runResults[p]),
      ),
    [repos, statuses, skipPathSet, runResults],
  );

  /** 次级栏：工作区干净的项目 */
  const cleanRepos = useMemo(
    () =>
      repos.filter(
        (p) => !skipPathSet.has(p) && classifyRepo(statuses[p]) === "clean" && !runResults[p],
      ),
    [repos, statuses, skipPathSet, runResults],
  );

  const failedRepoCount = useMemo(
    () => visibleRepos.filter((p) => runResults[p]?.status === "failed").length,
    [visibleRepos, runResults],
  );

  const selectedRepos = useMemo(
    () => visibleRepos.filter((r) => selected.has(r)),
    [visibleRepos, selected],
  );

  /** 拖拽排序作用于可见子集，写回时保持被隐藏项目的原有位置 */
  const handleReorderVisible = useCallback((nextVisible: string[]) => {
    setRepos((prev) => {
      const visibleSet = new Set(nextVisible);
      let i = 0;
      return prev.map((p) => (visibleSet.has(p) ? nextVisible[i++] : p));
    });
  }, []);

  const handleAdd = async () => {
    try {
      const result = await open({
        directory: true,
        multiple: true,
        title: "选择本地项目目录",
      });
      if (!result) return;
      const list = Array.isArray(result) ? result : [result];
      setRepos((prev) => {
        const set = new Set(prev);
        list.forEach((p) => set.add(p));
        return Array.from(set);
      });
      pushToast(`已添加 ${list.length} 个目录`, "success");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「添加目录」",
        status: "success",
        detail: `已添加 ${list.length} 个目录`,
      });
      // 添加完自动检测
      setTimeout(() => {
        void runCheckFor(list);
      }, 50);
    } catch (e) {
      pushToast(`添加目录失败: ${e}`, "error");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「添加目录」",
        status: "error",
        detail: `添加目录失败: ${e}`,
      });
    }
  };

  const handleRemove = (path: string) => {
    if (runningRepos.has(path)) {
      pushToast("该项目正在执行任务，请先取消后再移出", "error");
      return;
    }
    setConfirmRemove([path]);
  };

  const handleBatchRemove = () => {
    const targets = selectedRepos;
    if (targets.length === 0) {
      pushToast("请先勾选至少一个项目", "info");
      return;
    }
    const busy = targets.filter((p) => runningRepos.has(p));
    if (busy.length > 0) {
      pushToast(`有 ${busy.length} 个项目正在执行任务，请先取消后再移出`, "error");
      return;
    }
    setConfirmRemove(targets);
  };

  const confirmRemoveRepos = () => {
    const paths = confirmRemove;
    if (!paths || paths.length === 0) return;
    const target = new Set(paths);

    setRepos((prev) => prev.filter((p) => !target.has(p)));
    setSelected((prev) => {
      const ns = new Set(prev);
      paths.forEach((p) => ns.delete(p));
      return ns;
    });
    setStatuses((prev) => {
      const next = { ...prev };
      paths.forEach((p) => delete next[p]);
      return next;
    });
    setRepoMeta((prev) => {
      const next = { ...prev };
      paths.forEach((p) => delete next[p]);
      return next;
    });
    setScannedRepos((prev) => {
      const ns = new Set(prev);
      paths.forEach((p) => ns.delete(p));
      return ns;
    });
    setRepoLogs((prev) => {
      const next = { ...prev };
      paths.forEach((p) => delete next[p]);
      return next;
    });
    clearRunResults(paths);

    setConfirmRemove(null);
    const tip =
      paths.length > 1
        ? `已移出 ${paths.length} 个项目（本地文件未删除）`
        : `已移出「${getRepoName(paths[0])}」（本地文件未删除）`;
    pushToast(tip, "info");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: paths.length > 1 ? "点击「批量移出监控」" : "移出监控",
      status: "success",
      detail: `${tip}：${paths.map((p) => getRepoName(p)).join("、")}`,
    });
  };

  /** 把项目移入跳过检测清单（不删除本地文件，之后每次检测都忽略） */
  const skipRepos = useCallback(
    (paths: string[], opts: { silent?: boolean } = {}) => {
      if (paths.length === 0) return;
      const target = new Set(paths);
      addToSkipList(
        paths.map((p) => ({
          path: p,
          name: getRepoName(p),
          kind: "manual" as const,
          reason: SKIP_REASON_MANUAL,
        })),
      );
      setRepos((prev) => prev.filter((p) => !target.has(p)));
      setSelected((prev) => {
        const ns = new Set(prev);
        paths.forEach((p) => ns.delete(p));
        return ns;
      });
      setScannedRepos((prev) => {
        const ns = new Set(prev);
        paths.forEach((p) => ns.delete(p));
        return ns;
      });
      clearRunResults(paths);
      if (!opts.silent) {
        pushToast(
          paths.length > 1
            ? `已将 ${paths.length} 个项目加入跳过检测`
            : `已跳过检测「${getRepoName(paths[0])}」`,
          "info",
        );
      }
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: paths.length > 1 ? "点击「批量跳过检测」" : "点击「跳过检测」",
        status: "success",
        detail: paths.map((p) => getRepoName(p)).join("、"),
      });
    },
    [addToSkipList, clearRunResults, pushToast],
  );

  const handleBatchSkip = () => {
    const targets = selectedRepos;
    if (targets.length === 0) {
      pushToast("请先勾选至少一个项目", "info");
      return;
    }
    const busy = targets.filter((p) => runningRepos.has(p));
    if (busy.length > 0) {
      pushToast(`有 ${busy.length} 个项目正在执行任务，请先取消后再跳过`, "error");
      return;
    }
    skipRepos(targets);
  };

  /** 从跳过清单恢复：下次检测重新纳入 */
  const handleRestoreSkip = (path: string) => {
    setSkipList((prev) => prev.filter((s) => s.path !== path));
    pushToast(`已恢复「${getRepoName(path)}」，重新检测后生效`, "info");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "恢复检测",
      status: "info",
      detail: path,
    });
  };

  const handleRestoreAllSkip = () => {
    const n = skipList.length;
    if (n === 0) return;
    setSkipList([]);
    pushToast(`已恢复全部 ${n} 项，重新检测后生效`, "info");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "恢复全部跳过项",
      status: "info",
      detail: `共 ${n} 项`,
    });
  };

  const handleToggle = (path: string) => {
    setSelected((prev) => {
      const ns = new Set(prev);
      if (ns.has(path)) ns.delete(path);
      else ns.add(path);
      return ns;
    });
  };

  const handleSelectAll = () => {
    if (visibleRepos.length > 0 && selectedRepos.length === visibleRepos.length) setSelected(new Set());
    else setSelected(new Set(visibleRepos));
  };

  const runCheckFor = useCallback(
    async (targets: string[]) => {
      if (targets.length === 0) return;
      setCheckingRepos((prev) => {
        const ns = new Set(prev);
        targets.forEach((t) => ns.add(t));
        return ns;
      });
      try {
        const result = await invoke<GitStatus[]>("check_git_status", { paths: targets });
        setStatuses((prev) => {
          const next = { ...prev };
          result.forEach((s) => {
            next[s.path] = s;
          });
          return next;
        });

        // 没有 git 关联的目录直接进入跳过清单，不再占用列表
        const nonGit = result.filter((s) => !s.is_repo);
        if (nonGit.length > 0) {
          const nonGitPaths = new Set(nonGit.map((s) => s.path));
          addToSkipList(
            nonGit.map((s) => ({
              path: s.path,
              name: s.name || getRepoName(s.path),
              kind: "dir" as const,
              reason: s.error || "没有 git 关联",
            })),
          );
          setRepos((prev) => prev.filter((p) => !nonGitPaths.has(p)));
          setSelected((prev) => {
            const ns = new Set(prev);
            nonGitPaths.forEach((p) => ns.delete(p));
            return ns;
          });
          clearRunResults(Array.from(nonGitPaths));
        }
      } catch (e) {
        pushToast(`检测失败: ${e}`, "error");
      } finally {
        setCheckingRepos((prev) => {
          const ns = new Set(prev);
          targets.forEach((t) => ns.delete(t));
          return ns;
        });
      }
    },
    [addToSkipList, clearRunResults, pushToast],
  );

  /**
   * 扫描根目录：每次都从零开始重新检测。
   * 上一轮扫描出来的项目会被整体替换，非 git 的文件/文件夹由后端归到"省略清单"里。
   */
  const runScan = useCallback(
    async (
      root: string,
      opts: { silent?: boolean; skipPaths?: string[] } = {},
    ): Promise<GitScanResult | null> => {
      if (!root) return null;
      setScanning(true);
      try {
        const res = await invoke<GitScanResult>("scan_git_repos", {
          roots: [root],
          maxDepth: scanDepth,
          skipPaths: opts.skipPaths ?? skipList.map((s) => s.path),
        });

        const found = res.repos.map((r) => r.path);
        const foundSet = new Set(found);
        const stale = Array.from(scannedRepos).filter((p) => !foundSet.has(p));

        // 后端上报的无 git 文件/文件夹进入跳过清单，下次检测直接忽略
        addToSkipList(res.skipped);

        setStatuses((prev) => {
          const next = { ...prev };
          // 清掉上轮扫描遗留、本轮已不存在的项目状态
          stale.forEach((p) => delete next[p]);
          res.repos.forEach((s) => {
            next[s.path] = s;
          });
          return next;
        });

        setRepoLogs((prev) => {
          if (stale.length === 0) return prev;
          const next = { ...prev };
          stale.forEach((p) => delete next[p]);
          return next;
        });

        clearRunResults(stale);

        // 手动添加的项目保持原位与原顺序，扫描结果整体替换
        setRepos((prev) => {
          const manual = prev.filter((p) => !scannedRepos.has(p));
          const manualSet = new Set(manual);
          return [...manual, ...found.filter((p) => !manualSet.has(p))];
        });

        setSelected((prev) => {
          const ns = new Set<string>();
          prev.forEach((p) => {
            if (!scannedRepos.has(p) || foundSet.has(p)) ns.add(p);
          });
          return ns;
        });

        setScannedRepos(foundSet);
        setScanSummary({ total: res.total, changed: res.changed, truncated: res.truncated });

        if (!opts.silent) {
          const msg = `扫描到 ${res.total} 个 git 项目，${res.changed} 个有待提交改动`;
          pushToast(res.truncated ? `${msg}（已达数量上限）` : msg, "success");
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "扫描根目录",
            status: "success",
            detail: `${root} → ${msg}；新增跳过 ${res.skipped_total} 个无 git 的文件/文件夹`,
          });
        }
        return res;
      } catch (e) {
        pushToast(`扫描失败: ${e}`, "error");
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "扫描根目录",
          status: "error",
          detail: `扫描失败: ${e}`,
        });
        return null;
      } finally {
        setScanning(false);
      }
    },
    [scanDepth, scannedRepos, skipList, addToSkipList, clearRunResults, pushToast],
  );

  const handlePickRoot = async () => {
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: "选择包含多个项目的根目录",
      });
      if (!result) return;
      const root = Array.isArray(result) ? result[0] : result;
      if (!root) return;
      setScanRoot(root);
      // 重新选择根目录是唯一会清空跳过检测清单的操作
      setSkipList([]);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「选择根目录」",
        status: "info",
        detail: `${root}（清空跳过清单，重新开始检测）`,
      });
      await runScan(root, { skipPaths: [] });
    } catch (e) {
      pushToast(`选择根目录失败: ${e}`, "error");
    }
  };

  const handleClearRoot = () => {
    setScanRoot("");
    // 清掉上一次扫描留下的一切，只保留手动添加的项目
    const stale = Array.from(scannedRepos);
    setRepos((prev) => prev.filter((p) => !scannedRepos.has(p)));
    setStatuses((prev) => {
      const next = { ...prev };
      stale.forEach((p) => delete next[p]);
      return next;
    });
    setSelected((prev) => {
      const ns = new Set(prev);
      stale.forEach((p) => ns.delete(p));
      return ns;
    });
    setRepoLogs((prev) => {
      const next = { ...prev };
      stale.forEach((p) => delete next[p]);
      return next;
    });
    clearRunResults(stale);
    setScannedRepos(new Set());
    setScanSummary(null);
    setSkipList([]);
    pushToast("已清除扫描根目录、检测结果和跳过清单", "info");
  };

  const handleCheckAll = async () => {
    const manualTargets = (selectedRepos.length > 0 ? selectedRepos : repos).filter(
      (p) => !scannedRepos.has(p),
    );

    if (!scanRoot && repos.length === 0) {
      pushToast("请先选择一个根目录，或手动添加项目目录", "info");
      return;
    }

    if (scanRoot) {
      const res = await runScan(scanRoot);
      if (manualTargets.length > 0) await runCheckFor(manualTargets);
      if (res) {
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "点击「全部检测」",
          status: "success",
          detail: `重新扫描 ${scanRoot}：${res.total} 个 git 项目，${res.changed} 个有待提交改动`,
        });
      }
      return;
    }

    const targets = selectedRepos.length > 0 ? selectedRepos : repos;
    await runCheckFor(targets);
    pushToast(`已检测 ${targets.length} 个目录`, "success");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「全部检测」",
      status: "success",
      detail: `已检测 ${targets.length} 个目录`,
    });
  };

  /** 为一组仓库顺序执行 pipeline（每个仓库用独立 sessionId + 独立监听） */
  const runPipelineFor = useCallback(
    async (
      targets: string[],
      opts: { silent?: boolean } = {},
    ): Promise<PipelineRunSummary> => {
      const summary: PipelineRunSummary = { succeeded: [], failed: [], cancelled: [] };
      if (targets.length === 0) {
        if (!opts.silent) pushToast("请先选择至少一个目录", "info");
        return summary;
      }

      // 校验每个仓库
      const emptyMsgRepos: string[] = [];
      for (const repo of targets) {
        const presetId = getPresetId(repo);
        const preset = config.presets.find((p) => p.id === presetId) ?? config.presets[0];
        const enabled = preset?.steps.filter((s) => s.enabled) ?? [];
        if (enabled.length === 0) {
          pushToast(`「${getRepoName(repo)}」没有可执行的步骤`, "error");
          return summary;
        }
        if (!getMessage(repo).trim()) {
          emptyMsgRepos.push(repo);
        }
      }
      if (emptyMsgRepos.length > 0) {
        setMessageErrorRepos(new Set(emptyMsgRepos));
        // 1.2s 后自动清除标记（用户开始输入时也会清除）
        setTimeout(() => {
          setMessageErrorRepos((prev) => {
            if (prev.size === 0) return prev;
            const ns = new Set(prev);
            emptyMsgRepos.forEach((r) => ns.delete(r));
            return ns;
          });
        }, 1200);
        const name = getRepoName(emptyMsgRepos[0]);
        const rest = emptyMsgRepos.length > 1 ? ` 等 ${emptyMsgRepos.length} 个项目` : "";
        pushToast(`请先填写「${name}」${rest}的提交备注`, "error");
        return summary;
      }

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      for (const repo of targets) {
        const sessionId = genId();
        const event = `git-pipeline-log-${sessionId}`;
        const presetId = getPresetId(repo);
        const preset = config.presets.find((p) => p.id === presetId) ?? config.presets[0];
        const msg = getMessage(repo).trim();
        const st = statuses[repo];
        const repoName = getRepoName(repo);
        const vars: Record<string, string> = {
          message: msg,
          branch: st?.branch ?? "",
          repoName,
          date: dateStr,
          time: timeStr,
          user: "",
        };
        const steps = preset.steps
          .filter((s) => s.enabled)
          .map((s) => ({
            name: s.name,
            command: substitutePlaceholders(s.command, vars),
            enabled: s.enabled,
            continueOnError: s.continueOnError,
            allowEmptyCommit: s.allowEmptyCommit,
          }));

        resetLog(repo);
        appendLog(repo, `━━━━━━ ${repoName} · ${preset.name} ━━━━━━`);

        /**
         * 从日志里跟踪失败：出错策略为「跳过失败仓库 / 全部继续」时后端不会抛错，
         * 只靠 invoke 的返回值会把失败当成成功。
         */
        const trace = {
          repoFailed: false,
          failures: [] as string[],
          tail: [] as string[],
          detail: [] as string[],
        };

        const unlisten = await listen<string>(event, (ev) => {
          const line = ev.payload;
          appendLog(repo, line);
          const text = line.trim();
          if (!text || text.includes("━━━")) return;
          trace.tail.push(text.slice(0, 200));
          if (trace.tail.length > OUTCOME_DETAIL_LINES) trace.tail.shift();
          if (!text.startsWith("✗")) return;
          trace.failures.push(text);
          if (isRepoFailureLine(text)) {
            trace.repoFailed = true;
            // 快照失败发生时的输出，便于日志被清空后仍能看到原因
            if (trace.detail.length === 0) {
              trace.detail = trace.tail.filter((l) => !isRepoFailureLine(l));
            }
          }
        });

        clearRunResults([repo]);
        setRunningRepos((prev) => {
          const ns = new Set(prev);
          ns.add(repo);
          return ns;
        });
        setRepoSessions((prev) => ({ ...prev, [repo]: sessionId }));

        let cancelled = false;
        let outcome: RunOutcome | null = null;
        const markOutcome = (status: RunOutcome["status"], reason: string) => {
          outcome = {
            status,
            reason,
            detail: trace.detail.length > 0 ? trace.detail : trace.tail.slice(-OUTCOME_DETAIL_LINES),
            presetName: preset.name,
            at: Date.now(),
          };
        };

        try {
          await invoke("run_git_pipeline", {
            params: {
              sessionId,
              repos: [repo],
              steps,
              onRepoError: config.onRepoError,
            },
          });
          // 日志事件走 IPC，最后几行可能比 invoke 的返回值稍晚到，留一点时间再判定成败
          await new Promise((r) => setTimeout(r, 150));
          if (trace.repoFailed) {
            const reason = buildFailureReason(trace.failures, "执行失败");
            markOutcome("failed", reason);
            if (!opts.silent) pushToast(`「${repoName}」提交失败：${reason}`, "error");
            logOperation({
              page: LOG_PAGE,
              pageLabel: LOG_PAGE_LABEL,
              action: `一键提交 · ${repoName}`,
              status: "error",
              detail: `预设「${preset.name}」执行失败：${reason}`,
            });
          } else {
            if (!opts.silent) pushToast(`「${repoName}」执行完成`, "success");
            logOperation({
              page: LOG_PAGE,
              pageLabel: LOG_PAGE_LABEL,
              action: `一键提交 · ${repoName}`,
              status: "success",
              detail: `预设「${preset.name}」执行完成，提交备注：${msg || "-"}`,
            });
          }
        } catch (e) {
          const msgText = String(e);
          if (msgText.includes("已取消")) {
            cancelled = true;
            appendLog(repo, "✗ 已取消");
            markOutcome("cancelled", "任务已取消");
            pushToast(`「${repoName}」已取消`, "info");
            logOperation({
              page: LOG_PAGE,
              pageLabel: LOG_PAGE_LABEL,
              action: `一键提交 · ${repoName}`,
              status: "info",
              detail: "任务已取消",
            });
          } else {
            const reason = buildFailureReason(trace.failures, msgText);
            appendLog(repo, `✗ 失败: ${msgText}`);
            markOutcome("failed", reason);
            if (!opts.silent) pushToast(`「${repoName}」提交失败：${reason}`, "error");
            logOperation({
              page: LOG_PAGE,
              pageLabel: LOG_PAGE_LABEL,
              action: `一键提交 · ${repoName}`,
              status: "error",
              detail: `执行失败: ${msgText}`,
            });
          }
        } finally {
          unlisten();
          const settled = outcome as RunOutcome | null;
          if (settled) {
            setRunResults((prev) => ({ ...prev, [repo]: settled }));
            if (settled.status === "failed") summary.failed.push(repo);
            else summary.cancelled.push(repo);
          } else {
            summary.succeeded.push(repo);
          }
          setRunningRepos((prev) => {
            const ns = new Set(prev);
            ns.delete(repo);
            return ns;
          });
          setRepoSessions((prev) => {
            const { [repo]: _, ...rest } = prev;
            return rest;
          });
          // 执行完后刷新状态
          void runCheckFor([repo]);
        }

        // 批量模式下，按出错策略决定是否继续
        if (cancelled && config.onRepoError === "stop-all") break;
      }

      return summary;
    },
    [
      config,
      getPresetId,
      getMessage,
      statuses,
      resetLog,
      appendLog,
      clearRunResults,
      runCheckFor,
      pushToast,
    ],
  );

  const handleRunOne = (path: string) => {
    if (runningRepos.has(path)) return;
    // 记录最近使用的备注
    updateRepoMeta(path, { lastMessage: getMessage(path) });
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「一键提交」",
      status: "info",
      detail: `项目：${getRepoName(path)}`,
    });
    void runPipelineFor([path]);
  };

  const handleCancelOne = async (path: string) => {
    const sid = repoSessions[path];
    if (!sid) return;
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「取消」",
      status: "info",
      detail: `项目：${getRepoName(path)}`,
    });
    try {
      await invoke("cancel_git_pipeline", { sessionId: sid });
      pushToast(`「${getRepoName(path)}」已请求取消`, "info");
    } catch (e) {
      pushToast(`取消失败: ${e}`, "error");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "取消任务",
        status: "error",
        detail: `取消失败: ${e}`,
      });
    }
  };

  const handleBatchRun = async () => {
    const targets = selectedRepos;
    if (targets.length === 0) {
      pushToast("请先勾选至少一个目录", "info");
      return;
    }
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「批量提交」",
      status: "info",
      detail: `共 ${targets.length} 个仓库：${targets.map((t) => getRepoName(t)).join("、")}`,
    });
    setBatchRunning(true);
    batchSessionRef.current = genId();
    try {
      const summary = await runPipelineFor(targets, { silent: true });
      const parts = [`成功 ${summary.succeeded.length}`];
      if (summary.failed.length > 0) parts.push(`失败 ${summary.failed.length}`);
      if (summary.cancelled.length > 0) parts.push(`取消 ${summary.cancelled.length}`);
      const detail = `批量任务结束（${targets.length} 个仓库）：${parts.join("，")}`;
      pushToast(detail, summary.failed.length > 0 ? "error" : "success");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "批量提交",
        status: summary.failed.length > 0 ? "error" : "success",
        detail:
          summary.failed.length > 0
            ? `${detail}；失败项目：${summary.failed.map((p) => getRepoName(p)).join("、")}`
            : detail,
      });
    } finally {
      setBatchRunning(false);
      batchSessionRef.current = "";
    }
  };

  const handleBatchCancel = async () => {
    // 取消所有正在执行的会话
    const sessions = Object.values(repoSessions);
    for (const sid of sessions) {
      try {
        await invoke("cancel_git_pipeline", { sessionId: sid });
      } catch {
        /* ignore */
      }
    }
    pushToast("已请求取消所有任务", "info");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「批量取消」",
      status: "info",
      detail: `已请求取消 ${sessions.length} 个任务`,
    });
  };

  const handleClearAllLogs = () => {
    setRepoLogs({});
    pushToast("已清空所有日志", "info");
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「清空日志」",
      status: "info",
      detail: "清空所有执行日志面板",
    });
  };

  // 统计
  const totalChangesAllRepos = useMemo(
    () => repos.reduce((sum, r) => sum + changeCount(statuses[r]), 0),
    [repos, statuses],
  );

  const activePresetGlobal = config.presets.find((p) => p.id === config.activePresetId) ?? config.presets[0];

  return (
    <div
      className="h-full w-full overflow-auto pb-24 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    >
      <Toasts toasts={toasts} onRemove={removeToast} />

      <ConfirmDialog
        open={!!confirmRemove}
        title={confirmRemove && confirmRemove.length > 1 ? "确认批量移出监控？" : "确认移出监控？"}
        description={
          confirmRemove ? (
            <>
              将从监控列表中移出
              {confirmRemove.length > 1 ? (
                <>
                  <span className="mx-1 font-semibold text-gray-800 dark:text-white/90">
                    {confirmRemove.length} 个项目
                  </span>
                  （{confirmRemove.slice(0, 3).map((p) => getRepoName(p)).join("、")}
                  {confirmRemove.length > 3 ? ` 等 ${confirmRemove.length} 个` : ""}）
                </>
              ) : (
                <span className="mx-1 font-semibold text-gray-800 dark:text-white/90">
                  {getRepoName(confirmRemove[0])}
                </span>
              )}
              。<span className="font-medium text-gray-700 dark:text-white/80">不会删除任何本地文件</span>
              ，重新检测后仍会出现。
            </>
          ) : null
        }
        confirmText="移出监控"
        danger
        onConfirm={confirmRemoveRepos}
        onCancel={() => setConfirmRemove(null)}
      />

      <div className="max-w-7xl mx-auto px-5 pt-6 space-y-5">
        {/* Chrome：单盒子 + 高度折叠动画 */}
        <div
          className="relative rounded-2xl overflow-hidden
            bg-white/55 dark:bg-white/[0.035]
            backdrop-blur-2xl backdrop-saturate-150
            shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_0_0_1px_rgba(255,255,255,0.15)]
            dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(255,255,255,0.035)]"
        >
          {/* 玻璃高光层 */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{
              background:
                "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%)",
              mixBlendMode: "overlay",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 35%, rgba(0,0,0,0.04) 100%)",
            }}
          />
          <div className="relative">
          {/* 顶部行：始终可见 */}
          <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 mr-auto min-w-0">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(139,92,246,0.25)]">
                <FolderGit2 size={15} className="text-white" />
              </div>
              <div className="min-w-0 flex items-baseline gap-2">
                <span className="text-sm font-semibold text-gray-800 dark:text-white/90 truncate">
                  Git Pipeline
                </span>
                <span className="hidden md:inline text-[10.5px] text-gray-400 dark:text-white/40 truncate">
                  卡片化监控多个项目
                </span>
              </div>
              <div className="hidden sm:flex items-center gap-2 text-[11px] text-gray-500 dark:text-white/50 ml-1">
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  待提交 <span className="font-semibold text-amber-500">{visibleRepos.length}</span>
                </span>
                {failedRepoCount > 0 && (
                  <>
                    <span className="text-gray-300 dark:text-white/20">·</span>
                    <span title="上次一键提交失败，卡片会保留在待提交栏">
                      提交失败 <span className="font-semibold text-rose-500">{failedRepoCount}</span>
                    </span>
                  </>
                )}
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  改动文件 <span className="font-semibold text-violet-500">{totalChangesAllRepos}</span>
                </span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  干净 <span className="font-semibold text-emerald-500">{cleanRepos.length}</span>
                </span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span title="跳过检测的文件、无 git 文件夹和手动跳过的项目">
                  已跳过 <span className="font-semibold text-gray-500 dark:text-white/60">{skipList.length}</span>
                </span>
                {runningRepos.size > 0 && (
                  <>
                    <span className="text-gray-300 dark:text-white/20">·</span>
                    <span>
                      运行中 <span className="font-semibold text-emerald-500">{runningRepos.size}</span>
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handlePickRoot}
              className="h-7 px-2.5 rounded-lg bg-violet-500 hover:bg-violet-600 text-white text-xs font-medium flex items-center gap-1 shadow-[0_0_10px_rgba(139,92,246,0.3)]"
              title="选择根目录（自动扫描里面的所有 git 项目）"
            >
              <FolderSearch size={12} />
            </button>
            <button
              type="button"
              onClick={handleAdd}
              className="h-7 px-2.5 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 text-violet-600 dark:text-violet-300 border border-violet-500/20 text-xs flex items-center gap-1"
              title="单独添加项目目录"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={handleCheckAll}
              disabled={scanning || (repos.length === 0 && !scanRoot)}
              className="h-7 px-2.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-600 dark:text-sky-300 border border-sky-500/20 text-xs flex items-center gap-1 disabled:opacity-50"
              title="全部检测"
            >
              <RefreshCw size={12} className={scanning ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs flex items-center gap-1"
              title="编辑预设"
            >
              <Settings2 size={12} />
            </button>
            <OperationLogButton page={LOG_PAGE} pageLabel={LOG_PAGE_LABEL} className="h-7" />
            <button
              type="button"
              onClick={() => setChromeCollapsed((v) => !v)}
              className="h-7 w-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-600 dark:text-white/70 flex items-center justify-center"
              title={chromeCollapsed ? "展开" : "折叠"}
            >
              <motion.span
                initial={false}
                animate={{ rotate: chromeCollapsed ? 0 : 180 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center justify-center"
              >
                <ChevronDown size={13} />
              </motion.span>
            </button>
          </div>

          {/* 展开内容：高度动画 */}
          <motion.div
            initial={false}
            animate={{
              height: chromeCollapsed ? 0 : "auto",
              opacity: chromeCollapsed ? 0 : 1,
            }}
            transition={{
              height: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.2, ease: "easeOut", delay: chromeCollapsed ? 0 : 0.08 },
            }}
            style={{ overflow: "hidden" }}
          >
            {/* 扫描根目录 */}
            <div className="border-t border-black/[0.06] dark:border-white/[0.08] px-3 py-2.5 flex items-start gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 shrink-0">
                <FolderSearch size={13} className="text-violet-500" />
                <span className="text-[11px] text-gray-500 dark:text-white/50">扫描根目录</span>
              </div>

              <div className="flex-1 min-w-[200px] flex items-center gap-1.5 flex-wrap">
                {!scanRoot ? (
                  <span className="text-[11px] text-gray-400 dark:text-white/40">
                    选一个父文件夹，点「全部检测」自动找出里面所有有改动的 git 项目
                  </span>
                ) : (
                  <span
                    title={scanRoot}
                    className="inline-flex items-center gap-1 max-w-[360px] h-7 pl-2 pr-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-600 dark:text-violet-300"
                  >
                    <span className="truncate">{scanRoot}</span>
                    <button
                      type="button"
                      onClick={handleClearRoot}
                      className="shrink-0 w-5 h-5 rounded-md hover:bg-violet-500/20 flex items-center justify-center"
                      title="清除根目录、检测结果和跳过清单"
                    >
                      <X size={11} />
                    </button>
                  </span>
                )}
                {skipList.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-slate-500/10 border border-slate-500/20 text-[11px] text-slate-600 dark:text-slate-300"
                    title="重新检测时会直接跳过；只有重新选择根目录才会清空"
                  >
                    <EyeOff size={11} /> 跳过 {skipList.length} 项
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handlePickRoot}
                  className="h-7 px-2.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-300 border border-violet-500/20 text-xs flex items-center gap-1.5"
                  title="重新选择根目录并从零开始检测"
                >
                  <FolderSearch size={12} /> {scanRoot ? "重新选择" : "选择根目录"}
                </button>
                <span className="text-[11px] text-gray-500 dark:text-white/50">深度</span>
                <Select
                  compact
                  align="end"
                  value={String(scanDepth)}
                  onChange={(v) => setScanDepth(Number(v))}
                  title="向下查找几层子目录，层级越深越慢"
                  options={SCAN_DEPTH_OPTIONS.map((d) => ({ value: String(d), label: `${d} 层` }))}
                />
              </div>
            </div>

            <div className="border-t border-black/[0.06] dark:border-white/[0.08] px-3 py-2.5 flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 mr-auto flex-wrap">
                {visibleRepos.length > 0 && (
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs"
                  >
                    {selectedRepos.length === visibleRepos.length ? "全不选" : "全选"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleAdd}
                  className="h-7 px-2.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-300 border border-violet-500/20 text-xs flex items-center gap-1.5"
                >
                  <FolderPlus size={12} /> 添加目录
                </button>
                <button
                  type="button"
                  onClick={handleCheckAll}
                  disabled={scanning || (repos.length === 0 && !scanRoot)}
                  className="h-7 px-2.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-300 border border-sky-500/20 text-xs flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw size={12} className={scanning ? "animate-spin" : undefined} />
                  {scanning ? "检测中…" : "全部检测"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs flex items-center gap-1.5"
                >
                  <Settings2 size={12} /> 编辑预设
                </button>
                {Object.keys(repoLogs).length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearAllLogs}
                    className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs flex items-center gap-1.5"
                  >
                    <Eraser size={12} /> 清空日志
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/50 flex-wrap">
                <span>默认预设：</span>
                <Select
                  compact
                  align="end"
                  value={config.activePresetId}
                  onChange={(v) => setConfig((c) => ({ ...c, activePresetId: v }))}
                  className="max-w-[180px]"
                  title="新增项目会默认使用该预设"
                  options={config.presets.map((p) => ({
                    value: p.id,
                    label: p.name,
                    hint: `${p.steps.filter((s) => s.enabled).length} 步`,
                  }))}
                />
                <span className="ml-1">错误策略：</span>
                <Select
                  compact
                  align="end"
                  value={config.onRepoError}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, onRepoError: v as PipelineConfig["onRepoError"] }))
                  }
                  options={[
                    { value: "stop-all", label: "整体中止" },
                    { value: "skip-repo", label: "跳过失败仓库" },
                    { value: "continue", label: "全部继续" },
                  ]}
                />
              </div>
            </div>
          </motion.div>
          </div>
        </div>

        {/* 批量执行 Bar */}
        {selectedRepos.length > 0 && (
          <motion.div
            layout
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-gradient-to-r from-violet-500/10 to-indigo-500/10 dark:from-violet-500/15 dark:to-indigo-500/15 border border-violet-500/25 p-3 flex items-center gap-3 flex-wrap"
          >
            <div className="flex items-center gap-2 mr-auto">
              <div className="w-8 h-8 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
                <Rocket size={14} className="text-violet-500" />
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-white/90">
                  已选中 {selectedRepos.length} 个项目
                </div>
                <div className="text-[11px] text-gray-500 dark:text-white/50">
                  默认执行 <code>{activePresetGlobal?.name}</code>，每个卡片可单独切换预设
                </div>
              </div>
            </div>

            {batchRunning ? (
              <button
                type="button"
                onClick={handleBatchCancel}
                className="h-9 px-4 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-600 dark:text-red-300 border border-red-500/25 text-sm font-medium flex items-center gap-2"
              >
                <Square size={13} /> 取消全部
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleBatchSkip}
                  className="h-9 px-4 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] hover:bg-violet-500/15 text-gray-700 dark:text-white/70 hover:text-violet-600 dark:hover:text-violet-300 border border-black/[0.08] dark:border-white/[0.10] hover:border-violet-500/25 text-sm font-medium flex items-center gap-2 transition-colors"
                  title="加入跳过清单，之后每次检测都忽略这些项目"
                >
                  <EyeOff size={13} /> 批量跳过检测
                </button>
                <button
                  type="button"
                  onClick={handleBatchRemove}
                  className="h-9 px-4 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/15 dark:hover:bg-red-500/20 text-gray-700 dark:text-white/70 hover:text-red-600 dark:hover:text-red-300 border border-black/[0.08] dark:border-white/[0.10] hover:border-red-500/25 text-sm font-medium flex items-center gap-2 transition-colors"
                  title="仅从监控列表移出，不会删除任何本地文件"
                >
                  <Trash2 size={13} /> 批量移出监控
                </button>
                <button
                  type="button"
                  onClick={handleBatchRun}
                  className="h-9 px-4 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white text-sm font-semibold flex items-center gap-2 shadow-[0_0_16px_rgba(139,92,246,0.4)]"
                >
                  <Rocket size={13} /> 批量一键提交
                </button>
              </>
            )}
          </motion.div>
        )}

        {/* Repos Grid */}
        <div className="rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl border border-black/[0.08] dark:border-white/[0.10] p-4">
          <SectionHeader
            icon={FolderGit2}
            title="待提交项目"
            count={visibleRepos.length}
            action={
              <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-white/50">
                {failedRepoCount > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/25 font-medium">
                    <CircleAlert size={11} />
                    {failedRepoCount} 个提交失败
                  </span>
                )}
                {scanSummary && (
                  <span title="最近一次扫描结果">
                    扫描到 {scanSummary.total} 个 git 项目
                    {scanSummary.truncated ? "（已达上限）" : ""}
                  </span>
                )}
                <span>{selected.size > 0 ? `已选 ${selected.size} 项` : "点击卡片复选框批量选中"}</span>
              </div>
            }
          />

          {visibleRepos.length === 0 ? (
            <div className="py-14 text-center">
              {scanning ? (
                <>
                  <RefreshCw size={36} className="mx-auto text-sky-500/70 mb-3 animate-spin" />
                  <div className="text-sm text-gray-500 dark:text-white/50">正在检测…</div>
                </>
              ) : cleanRepos.length > 0 ? (
                <>
                  <FolderCheck size={36} className="mx-auto text-emerald-500/70 mb-3" />
                  <div className="text-sm text-gray-500 dark:text-white/50">
                    {cleanRepos.length} 个项目工作区都是干净的，没有需要提交的内容
                  </div>
                  <div className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
                    它们都在下面的「工作区干净」栏里
                  </div>
                </>
              ) : repos.length === 0 ? (
                <>
                  <FolderSearch size={36} className="mx-auto text-gray-400 dark:text-white/30 mb-3" />
                  <div className="text-sm text-gray-500 dark:text-white/50">还没有选择要检测的目录</div>
                  <div className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
                    选一个包含多个项目的父文件夹，点「全部检测」即可列出所有需要提交的项目
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={handlePickRoot}
                      className="h-9 px-4 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-xs font-medium inline-flex items-center gap-1.5 shadow-[0_0_12px_rgba(139,92,246,0.35)]"
                    >
                      <FolderSearch size={13} /> 选择根目录
                    </button>
                    <button
                      type="button"
                      onClick={handleAdd}
                      className="h-9 px-4 rounded-xl bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-300 border border-violet-500/20 text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <FolderPlus size={13} /> 单独添加项目
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Check size={36} className="mx-auto text-emerald-500/70 mb-3" />
                  <div className="text-sm text-gray-500 dark:text-white/50">
                    没有需要提交的项目
                  </div>
                  <div className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
                    干净的项目在「工作区干净」栏，没有 git 关联的内容在「跳过检测」栏
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {visibleRepos.map((p) => (
                <DraggableRepoCard
                  key={p}
                  value={p}
                  allValues={visibleRepos}
                  onReorder={handleReorderVisible}
                  status={statuses[p]}
                  selected={selected.has(p)}
                  onToggle={() => handleToggle(p)}
                  onRemove={() => handleRemove(p)}
                  onSkip={() => skipRepos([p])}
                  onCheck={() => runCheckFor([p])}
                  onRun={() => handleRunOne(p)}
                  onCancel={() => handleCancelOne(p)}
                  checking={checkingRepos.has(p)}
                  running={runningRepos.has(p)}
                  presets={config.presets}
                  presetId={getPresetId(p)}
                  onPresetChange={(id) => updateRepoMeta(p, { presetId: id })}
                  message={getMessage(p)}
                  onMessageChange={(msg) => {
                    updateRepoMeta(p, { lastMessage: msg });
                    if (msg.trim() && messageErrorRepos.has(p)) {
                      setMessageErrorRepos((prev) => {
                        const ns = new Set(prev);
                        ns.delete(p);
                        return ns;
                      });
                    }
                  }}
                  messageError={messageErrorRepos.has(p)}
                  logs={repoLogs[p] ?? []}
                  onClearLogs={() => resetLog(p)}
                  outcome={runResults[p]}
                  onDismissOutcome={() => clearRunResults([p])}
                />
              ))}
            </div>
          )}
        </div>

        {/* 工作区干净的项目 */}
        {cleanRepos.length > 0 && (
          <CollapsibleSection
            icon={FolderCheck}
            title="工作区干净"
            hint="没有需要提交的改动"
            count={cleanRepos.length}
            accent="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/20"
            open={sectionsOpen.clean}
            onToggle={() => setSectionsOpen((s) => ({ ...s, clean: !s.clean }))}
          >
            <div className="space-y-0.5">
              {cleanRepos.map((p) => (
                <CleanRow
                  key={p}
                  path={p}
                  status={statuses[p]}
                  checking={checkingRepos.has(p)}
                  onCheck={() => runCheckFor([p])}
                  onSkip={() => skipRepos([p])}
                />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* 跳过检测清单 */}
        {skipList.length > 0 && (
          <CollapsibleSection
            icon={EyeOff}
            title="跳过检测"
            hint="每次检测都忽略，重新选择根目录才会清空"
            count={skipList.length}
            accent="bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/20"
            open={sectionsOpen.skip}
            onToggle={() => setSectionsOpen((s) => ({ ...s, skip: !s.skip }))}
            action={
              <button
                type="button"
                onClick={handleRestoreAllSkip}
                className="shrink-0 h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-sky-500/15 text-gray-600 dark:text-white/60 hover:text-sky-600 dark:hover:text-sky-300 text-[11px] flex items-center gap-1.5"
                title="全部恢复检测，下次检测重新纳入"
              >
                <Eye size={11} /> 全部恢复
              </button>
            }
          >
            <div className="space-y-0.5">
              {SKIP_KIND_ORDER.flatMap((kind) => {
                const group = skipList.filter((s) => s.kind === kind);
                if (group.length === 0) return [];
                const meta = SKIP_KIND_META[kind];
                return [
                  <div
                    key={`h-${kind}`}
                    className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium text-gray-400 dark:text-white/40"
                  >
                    {meta.label} · {group.length}
                  </div>,
                  ...group.map((item) => (
                    <SkipRow
                      key={item.path}
                      item={item}
                      onRestore={() => handleRestoreSkip(item.path)}
                    />
                  )),
                ];
              })}
            </div>
          </CollapsibleSection>
        )}
      </div>

      <AnimatePresence>
        {editorOpen && (
          <PresetEditor
            open={editorOpen}
            onClose={() => setEditorOpen(false)}
            config={config}
            onSave={(cfg) => {
              setConfig(cfg);
              pushToast("配置已保存", "success");
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
