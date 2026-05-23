import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react";
import {
  FolderGit2,
  FolderPlus,
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

// ==================== Constants ====================

const REPOS_KEY = "douyin-git-repos-v1";
const PIPELINE_KEY = "douyin-git-pipeline-v1";
const REPO_META_KEY = "douyin-git-repo-meta-v1";
const CHROME_COLLAPSED_KEY = "douyin-git-chrome-collapsed-v1";

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
      layout
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
  isDragging?: boolean;
}

function RepoCard({
  path,
  status,
  selected,
  onToggle,
  onRemove,
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

  useEffect(() => {
    if (running && logs.length > 0) setLogExpanded(true);
  }, [running, logs.length]);

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
    : hasError
    ? "from-rose-500 to-red-500"
    : projectAccent;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
      }}
      exit={{ opacity: 0, scale: 0.95 }}
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
          onClick={onRemove}
          disabled={running}
          className="shrink-0 w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/20 text-gray-500 dark:text-white/60 hover:text-red-500 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="移除该目录"
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
            className="flex-[1.2] h-8 rounded-lg bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-[0_0_12px_rgba(139,92,246,0.35)] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            title="按预设命令顺序执行：一键提交 git"
          >
            <Rocket size={12} /> 一键提交
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
  const [statuses, setStatuses] = useState<Record<string, GitStatus>>({});
  const [repoMeta, setRepoMeta] = useState<Record<string, RepoMeta>>(() => loadRepoMeta());
  const [config, setConfig] = useState<PipelineConfig>(() => loadConfig());
  const [editorOpen, setEditorOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  /** 提交备注为空时临时标记的仓库（用于红色闪烁提示） */
  const [messageErrorRepos, setMessageErrorRepos] = useState<Set<string>>(new Set());

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

  /** 每个仓库独立的运行态/检测态/session/日志 */
  const [runningRepos, setRunningRepos] = useState<Set<string>>(new Set());
  const [checkingRepos, setCheckingRepos] = useState<Set<string>>(new Set());
  const [repoSessions, setRepoSessions] = useState<Record<string, string>>({});
  const [repoLogs, setRepoLogs] = useState<Record<string, string[]>>({});

  /** 全局批量执行态 */
  const [batchRunning, setBatchRunning] = useState(false);
  const batchSessionRef = useRef<string>("");

  /** 删除确认框 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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

  const selectedRepos = useMemo(() => repos.filter((r) => selected.has(r)), [repos, selected]);

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
      // 添加完自动检测
      setTimeout(() => {
        void runCheckFor(list);
      }, 50);
    } catch (e) {
      pushToast(`添加目录失败: ${e}`, "error");
    }
  };

  const handleRemove = (path: string) => {
    if (runningRepos.has(path)) {
      pushToast("该项目正在执行任务，请先取消后再移除", "error");
      return;
    }
    setConfirmRemove(path);
  };

  const confirmRemoveRepo = () => {
    const path = confirmRemove;
    if (!path) return;
    setRepos((prev) => prev.filter((p) => p !== path));
    setSelected((prev) => {
      const ns = new Set(prev);
      ns.delete(path);
      return ns;
    });
    setStatuses((prev) => {
      const { [path]: _, ...rest } = prev;
      return rest;
    });
    setRepoMeta((prev) => {
      const { [path]: _, ...rest } = prev;
      return rest;
    });
    resetLog(path);
    setConfirmRemove(null);
    pushToast("已移除目录", "info");
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
    if (selected.size === repos.length) setSelected(new Set());
    else setSelected(new Set(repos));
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
    [pushToast],
  );

  const handleCheckAll = async () => {
    const targets = selectedRepos.length > 0 ? selectedRepos : repos;
    if (targets.length === 0) {
      pushToast("请先添加至少一个目录", "info");
      return;
    }
    await runCheckFor(targets);
    pushToast(`已检测 ${targets.length} 个目录`, "success");
  };

  /** 为一组仓库顺序执行 pipeline（每个仓库用独立 sessionId + 独立监听） */
  const runPipelineFor = useCallback(
    async (
      targets: string[],
      opts: { silent?: boolean } = {},
    ): Promise<void> => {
      if (targets.length === 0) {
        if (!opts.silent) pushToast("请先选择至少一个目录", "info");
        return;
      }

      // 校验每个仓库
      const emptyMsgRepos: string[] = [];
      for (const repo of targets) {
        const presetId = getPresetId(repo);
        const preset = config.presets.find((p) => p.id === presetId) ?? config.presets[0];
        const enabled = preset?.steps.filter((s) => s.enabled) ?? [];
        if (enabled.length === 0) {
          pushToast(`「${getRepoName(repo)}」没有可执行的步骤`, "error");
          return;
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
        return;
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

        const unlisten = await listen<string>(event, (ev) => {
          appendLog(repo, ev.payload);
        });

        setRunningRepos((prev) => {
          const ns = new Set(prev);
          ns.add(repo);
          return ns;
        });
        setRepoSessions((prev) => ({ ...prev, [repo]: sessionId }));

        let cancelled = false;
        try {
          await invoke("run_git_pipeline", {
            params: {
              sessionId,
              repos: [repo],
              steps,
              onRepoError: config.onRepoError,
            },
          });
          if (!opts.silent) pushToast(`「${repoName}」执行完成`, "success");
        } catch (e) {
          const msgText = String(e);
          if (msgText.includes("已取消")) {
            cancelled = true;
            appendLog(repo, "✗ 已取消");
            pushToast(`「${repoName}」已取消`, "info");
          } else {
            appendLog(repo, `✗ 失败: ${msgText}`);
            if (!opts.silent) pushToast(`「${repoName}」执行失败`, "error");
          }
        } finally {
          unlisten();
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
    },
    [
      config,
      getPresetId,
      getMessage,
      statuses,
      resetLog,
      appendLog,
      runCheckFor,
      pushToast,
    ],
  );

  const handleRunOne = (path: string) => {
    if (runningRepos.has(path)) return;
    // 记录最近使用的备注
    updateRepoMeta(path, { lastMessage: getMessage(path) });
    void runPipelineFor([path]);
  };

  const handleCancelOne = async (path: string) => {
    const sid = repoSessions[path];
    if (!sid) return;
    try {
      await invoke("cancel_git_pipeline", { sessionId: sid });
      pushToast(`「${getRepoName(path)}」已请求取消`, "info");
    } catch (e) {
      pushToast(`取消失败: ${e}`, "error");
    }
  };

  const handleBatchRun = async () => {
    const targets = selectedRepos;
    if (targets.length === 0) {
      pushToast("请先勾选至少一个目录", "info");
      return;
    }
    setBatchRunning(true);
    batchSessionRef.current = genId();
    try {
      await runPipelineFor(targets, { silent: true });
      pushToast(`批量任务完成（${targets.length} 个仓库）`, "success");
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
  };

  const handleClearAllLogs = () => {
    setRepoLogs({});
    pushToast("已清空所有日志", "info");
  };

  // 统计
  const totalChangesAllRepos = useMemo(() => {
    let n = 0;
    repos.forEach((r) => {
      const s = statuses[r];
      if (s?.is_repo) n += s.modified + s.added + s.deleted + s.renamed + s.untracked + s.conflicted;
    });
    return n;
  }, [repos, statuses]);

  const reposWithChanges = useMemo(() => {
    let n = 0;
    repos.forEach((r) => {
      const s = statuses[r];
      if (s?.is_repo && s.modified + s.added + s.deleted + s.renamed + s.untracked + s.conflicted > 0) n++;
    });
    return n;
  }, [repos, statuses]);

  const activePresetGlobal = config.presets.find((p) => p.id === config.activePresetId) ?? config.presets[0];

  return (
    <div
      className="h-full w-full overflow-auto pb-24 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    >
      <Toasts toasts={toasts} onRemove={removeToast} />

      <ConfirmDialog
        open={!!confirmRemove}
        title="确认移除项目？"
        description={
          confirmRemove ? (
            <>
              将从监控列表中移除
              <span className="mx-1 font-semibold text-gray-800 dark:text-white/90">
                {getRepoName(confirmRemove)}
              </span>
              。只会从本工具移除，不会删除本地文件。
            </>
          ) : null
        }
        confirmText="移除"
        danger
        onConfirm={confirmRemoveRepo}
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
                  项目 <span className="font-semibold text-gray-800 dark:text-white/90">{repos.length}</span>
                </span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  有改动 <span className="font-semibold text-amber-500">{reposWithChanges}</span>
                </span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  改动文件 <span className="font-semibold text-violet-500">{totalChangesAllRepos}</span>
                </span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>
                  运行中 <span className="font-semibold text-emerald-500">{runningRepos.size}</span>
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleAdd}
              className="h-7 px-2.5 rounded-lg bg-violet-500 hover:bg-violet-600 text-white text-xs font-medium flex items-center gap-1 shadow-[0_0_10px_rgba(139,92,246,0.3)]"
              title="添加目录"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={handleCheckAll}
              disabled={repos.length === 0}
              className="h-7 px-2.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-600 dark:text-sky-300 border border-sky-500/20 text-xs flex items-center gap-1 disabled:opacity-50"
              title="全部检测"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs flex items-center gap-1"
              title="编辑预设"
            >
              <Settings2 size={12} />
            </button>
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
            <div className="border-t border-black/[0.06] dark:border-white/[0.08] px-3 py-2.5 flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 mr-auto flex-wrap">
                {repos.length > 0 && (
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="h-7 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs"
                  >
                    {selected.size === repos.length ? "全不选" : "全选"}
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
                  disabled={repos.length === 0}
                  className="h-7 px-2.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-300 border border-sky-500/20 text-xs flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw size={12} /> 全部检测
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
              <button
                type="button"
                onClick={handleBatchRun}
                className="h-9 px-4 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white text-sm font-semibold flex items-center gap-2 shadow-[0_0_16px_rgba(139,92,246,0.4)]"
              >
                <Rocket size={13} /> 批量一键提交
              </button>
            )}
          </motion.div>
        )}

        {/* Repos Grid */}
        <div className="rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl border border-black/[0.08] dark:border-white/[0.10] p-4">
          <SectionHeader
            icon={FolderGit2}
            title="监控项目"
            count={repos.length}
            action={
              <div className="text-[11px] text-gray-500 dark:text-white/50">
                {selected.size > 0 ? `已选 ${selected.size} 项` : "点击卡片复选框批量选中"}
              </div>
            }
          />

          {repos.length === 0 ? (
            <div className="py-14 text-center">
              <FolderPlus size={36} className="mx-auto text-gray-400 dark:text-white/30 mb-3" />
              <div className="text-sm text-gray-500 dark:text-white/50">还没有添加任何项目目录</div>
              <div className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
                可一次选择多个目录，支持 git 仓库的批量监控和提交
              </div>
              <button
                type="button"
                onClick={handleAdd}
                className="mt-4 h-9 px-4 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-xs font-medium inline-flex items-center gap-1.5 shadow-[0_0_12px_rgba(139,92,246,0.35)]"
              >
                <FolderPlus size={13} /> 选择目录
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <AnimatePresence initial={false}>
                {repos.map((p) => (
                  <DraggableRepoCard
                    key={p}
                    value={p}
                    allValues={repos}
                    onReorder={setRepos}
                    status={statuses[p]}
                    selected={selected.has(p)}
                    onToggle={() => handleToggle(p)}
                    onRemove={() => handleRemove(p)}
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
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
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
