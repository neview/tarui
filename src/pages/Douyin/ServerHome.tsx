import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "motion/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Server,
  Plus,
  Pencil,
  Trash2,
  Terminal,
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Check,
  ServerCrash,
  Monitor,
  Eye,
  EyeOff,
  Zap,
  Import,
  Download,
} from "lucide-react";

// ==================== Types ====================

interface ServerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  keyPath?: string;
}

interface ExecResult {
  host: string;
  name: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  status: "running" | "success" | "error";
}

interface ToastData {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

// ==================== Constants ====================

const STORAGE_KEY = "douyin-servers-v1";

const CARD_COLORS = [
  "from-[#C3B1E1]/30 to-[#A78BFA]/15",
  "from-[#FECACA]/30 to-[#F9A8D4]/15",
  "from-[#A7F3D0]/30 to-[#6EE7B7]/15",
  "from-[#BAE6FD]/30 to-[#7DD3FC]/15",
  "from-[#FDE68A]/30 to-[#FCD34D]/15",
  "from-[#FCA5A5]/30 to-[#FB7185]/15",
  "from-[#C4B5FD]/30 to-[#8B5CF6]/15",
  "from-[#99F6E4]/30 to-[#2DD4BF]/15",
];

let toastCounter = 0;

// ==================== Helpers ====================

function loadServers(): ServerInfo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveServers(servers: ServerInfo[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getColor(index: number) {
  return CARD_COLORS[index % CARD_COLORS.length];
}

// ==================== Sub Components ====================

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
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      className="flex items-center justify-between mb-4"
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
    >
      <div className="flex items-center gap-2.5">
        <motion.div
          className="w-8 h-8 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] flex items-center justify-center"
          animate={{
            boxShadow: hovered
              ? "0 0 20px rgba(167,139,250,0.2), inset 0 0 8px rgba(167,139,250,0.1)"
              : "0 0 0px transparent",
          }}
          transition={{ duration: 0.4 }}
        >
          <motion.div
            animate={{ rotate: hovered ? 12 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 15 }}
          >
            <Icon size={16} className="text-gray-700 dark:text-white/80" />
          </motion.div>
        </motion.div>
        <span className="text-gray-800 dark:text-white/90 text-sm font-semibold">{title}</span>
        {count !== undefined && count > 0 && (
          <motion.span
            key={count}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 20 }}
            className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-500/20 text-violet-600 dark:text-violet-300 border border-violet-500/20"
          >
            {count}
          </motion.span>
        )}
      </div>
      {action}
    </motion.div>
  );
}

function ClickToCopy({ value, children }: { value: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="relative inline-flex items-center gap-1 cursor-pointer" onClick={handleCopy}>
      {children}
      <AnimatePresence>
        {copied && (
          <motion.span
            initial={{ opacity: 0, y: 4, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.8 }}
            className="text-[10px] text-emerald-500 dark:text-emerald-400 font-medium whitespace-nowrap"
          >
            已复制
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function ServerCard({
  server,
  color,
  selected,
  index,
  pendingDelete,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: ServerInfo;
  color: string;
  selected: boolean;
  index: number;
  pendingDelete: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [justToggled, setJustToggled] = useState(false);

  const handleToggle = () => {
    setJustToggled(true);
    onToggle();
    setTimeout(() => setJustToggled(false), 400);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.85 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
      transition={{
        type: "spring",
        stiffness: 350,
        damping: 28,
        delay: index * 0.06,
      }}
      whileHover={{ y: -2, scale: 1.01 }}
      whileTap={{ scale: 0.97 }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      onClick={handleToggle}
      className="relative group cursor-pointer select-none"
    >
      <div
        className={`
          relative p-3 rounded-xl overflow-hidden
          backdrop-blur-2xl bg-white/80 dark:bg-white/[0.07] border
          shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.15)]
          transition-all duration-300
          ${selected ? "border-violet-300 dark:border-white/25 shadow-[0_2px_20px_rgba(139,92,246,0.15)] dark:shadow-[0_2px_20px_rgba(139,92,246,0.2)]" : "border-black/[0.08] dark:border-white/[0.10]"}
        `}
      >
        <motion.div
          className={`absolute inset-0 rounded-xl bg-gradient-to-br ${color}`}
          animate={{ opacity: isHovered ? 0.8 : 0.4 }}
          transition={{ duration: 0.3 }}
        />

        <AnimatePresence>
          {selected && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
              className="absolute top-2 left-2 w-4.5 h-4.5 rounded-full bg-violet-500 flex items-center justify-center z-20 shadow-[0_0_10px_rgba(139,92,246,0.3)] dark:shadow-[0_0_10px_rgba(139,92,246,0.5)]"
            >
              <Check size={10} className="text-white" strokeWidth={3} />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-emerald-400 z-20"
          animate={{
            boxShadow: [
              "0 0 3px rgba(52,211,153,0.4)",
              "0 0 8px rgba(52,211,153,0.7)",
              "0 0 3px rgba(52,211,153,0.4)",
            ],
          }}
          transition={{ duration: 2, repeat: Infinity }}
        />

        <div className="relative z-10">
          <div className="flex items-center gap-2.5 mb-2">
            <motion.div
              className="w-8 h-8 rounded-lg bg-black/[0.04] dark:bg-white/[0.10] border border-black/[0.06] dark:border-white/[0.10] flex items-center justify-center shrink-0"
              animate={{ rotate: isHovered ? 6 : 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 15 }}
            >
              <Server size={15} className="text-gray-600 dark:text-white/80" />
            </motion.div>
            <div className="min-w-0">
              <div className="text-gray-800 dark:text-white font-medium text-[13px] truncate leading-tight">{server.name}</div>
              <div className="text-gray-400 dark:text-white/45 text-[10px] leading-tight mt-0.5">{server.username}</div>
            </div>
          </div>

          <ClickToCopy value={`${server.host}:${server.port}`}>
            <span className="text-gray-500 dark:text-white/55 text-[11px] font-mono inline-block hover:text-gray-800 dark:hover:text-white/90 transition-colors">
              {server.host}:{server.port}
            </span>
          </ClickToCopy>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-black/[0.05] dark:border-white/[0.06]">
            <motion.span
              className="text-[10px] font-medium"
              animate={{
                color: selected ? "rgba(167,139,250,0.9)" : "rgba(255,255,255,0.35)",
              }}
            >
              {selected ? "已选中" : "未选中"}
            </motion.span>

            <motion.div
              className="flex gap-0.5"
              initial={false}
              animate={{ opacity: isHovered ? 1 : 0, x: isHovered ? 0 : 6 }}
              transition={{ duration: 0.2 }}
            >
                <motion.button
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                <Pencil size={12} className="text-gray-400 dark:text-white/60" />
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="p-1 rounded-md hover:bg-red-500/10 dark:hover:bg-red-500/20 transition-colors"
                animate={
                  pendingDelete
                    ? {
                        x: [0, -3, 3, -2, 2, 0],
                        backgroundColor: "rgba(239,68,68,0.15)",
                      }
                    : {}
                }
                transition={{ duration: 0.4 }}
              >
                {pendingDelete ? (
                  <span className="text-[10px] text-red-400 font-medium whitespace-nowrap">确认?</span>
                ) : (
                  <Trash2 size={12} className="text-gray-400 dark:text-white/60" />
                )}
              </motion.button>
            </motion.div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {justToggled && selected && (
          <motion.div
            className="absolute inset-0 rounded-xl border-2 border-violet-400/40 pointer-events-none"
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 1.06, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-12"
    >
      <motion.div
        className="w-20 h-20 rounded-3xl bg-gradient-to-br from-violet-500/15 to-indigo-500/10 border border-black/[0.04] dark:border-white/[0.06] flex items-center justify-center mb-5 shadow-[0_0_40px_rgba(139,92,246,0.08)]"
        animate={{ y: [-4, 4, -4] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      >
        <motion.div
          animate={{ rotate: [0, 5, -5, 0] }}
          transition={{ duration: 6, repeat: Infinity }}
        >
          <ServerCrash size={32} className="text-gray-400 dark:text-white/40" />
        </motion.div>
      </motion.div>
      <p className="text-gray-600 dark:text-white/60 text-sm font-medium mb-1">还没有服务器</p>
      <p className="text-gray-400 dark:text-white/35 text-xs mb-5">添加你的第一台服务器开始管理</p>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onAdd}
        className="relative px-5 py-2 rounded-xl text-sm font-medium text-violet-700 dark:text-white/90 bg-violet-500/15 dark:bg-violet-500/20 border border-violet-500/30 overflow-hidden"
      >
        <motion.div
          className="absolute inset-0 rounded-xl border border-violet-400/30 pointer-events-none"
          animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="relative z-10 flex items-center gap-1.5">
          <Plus size={15} />
          添加第一台服务器
        </span>
      </motion.button>
    </motion.div>
  );
}

function CommandInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <motion.div
        className="absolute -inset-[1px] rounded-xl pointer-events-none z-10"
        animate={{
          boxShadow: focused
            ? "0 0 0 2px rgba(139,92,246,0.3), 0 0 24px rgba(139,92,246,0.1)"
            : "0 0 0 0px transparent",
        }}
        transition={{ duration: 0.3 }}
      />
      <motion.div
        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full z-10"
        animate={{
          background: focused
            ? "linear-gradient(180deg, #A78BFA, #6366F1, transparent)"
            : "linear-gradient(180deg, rgba(255,255,255,0.08), transparent)",
        }}
        transition={{ duration: 0.4 }}
      />
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        placeholder="输入要执行的命令，多条命令用 && 连接，如:&#10;cd /home/wwwroot/project && pwd && ls -la"
        className="w-full rounded-xl bg-gray-50 dark:bg-black/40 border border-black/[0.08] dark:border-white/[0.10] px-4 pl-5 py-3 text-gray-800 dark:text-white/90 text-sm font-mono placeholder:text-gray-400 dark:placeholder:text-white/25 transition-all duration-300 resize-none outline-none disabled:opacity-40"
      />
      <motion.div
        className="absolute bottom-2 right-3 text-[10px] text-gray-400 dark:text-white/35"
        animate={{ opacity: value.length > 0 ? 1 : 0 }}
      >
        {value.split("\n").length} 行 · {value.length} 字符
      </motion.div>
    </div>
  );
}

function SelectAllCheckbox({
  selected,
  total,
  onToggle,
}: {
  selected: number;
  total: number;
  onToggle: () => void;
}) {
  const allSelected = selected === total && total > 0;
  const partial = selected > 0 && selected < total;

  return (
    <motion.label
      className="flex items-center gap-2 cursor-pointer select-none"
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.97 }}
      onClick={onToggle}
    >
      <motion.div
        className={`w-4 h-4 rounded-md border flex items-center justify-center transition-colors duration-200 ${
          allSelected
            ? "bg-violet-500 border-violet-400"
            : partial
              ? "bg-violet-500/40 border-violet-400/60"
              : "bg-black/[0.03] dark:bg-white/[0.04] border-black/[0.10] dark:border-white/[0.12]"
        }`}
        whileTap={{ scale: 0.8, rotate: 8 }}
        transition={{ type: "spring", stiffness: 500, damping: 20 }}
      >
        <AnimatePresence mode="wait">
          {allSelected && (
            <motion.div
              key="check"
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
            >
              <Check size={11} className="text-white" strokeWidth={3} />
            </motion.div>
          )}
          {partial && (
            <motion.div
              key="minus"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              exit={{ scaleX: 0 }}
              className="w-2 h-0.5 bg-white rounded-full"
            />
          )}
        </AnimatePresence>
      </motion.div>
      <span className="text-gray-500 dark:text-white/60 text-xs">
        全选
        <motion.span
          key={selected}
          initial={{ y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="text-gray-700 dark:text-white/80 ml-1"
        >
          ({selected}/{total})
        </motion.span>
      </span>
    </motion.label>
  );
}

function ExecuteButton({
  selectedCount,
  executing,
  onExecute,
}: {
  selectedCount: number;
  executing: boolean;
  onExecute: () => void;
}) {
  const canExecute = selectedCount > 0 && !executing;

  return (
    <motion.button
      whileHover={canExecute ? { scale: 1.03, y: -1 } : {}}
      whileTap={canExecute ? { scale: 0.97 } : {}}
      disabled={!canExecute}
      onClick={onExecute}
      className={`relative px-6 py-2.5 rounded-xl text-sm font-medium overflow-hidden transition-all duration-300 ${
        executing
          ? "bg-amber-500/15 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30"
          : canExecute
            ? "text-white border-0"
            : "bg-black/[0.03] dark:bg-white/[0.04] text-gray-400 dark:text-white/30 border border-black/[0.06] dark:border-white/[0.08] cursor-not-allowed"
      }`}
    >
      {canExecute && !executing && (
        <motion.div
          className="absolute inset-0 rounded-xl"
          style={{
            background: "linear-gradient(135deg, #8B5CF6, #6366F1, #818CF8)",
          }}
          animate={{
            boxShadow: [
              "0 4px 20px rgba(139,92,246,0.3)",
              "0 6px 28px rgba(139,92,246,0.5)",
              "0 4px 20px rgba(139,92,246,0.3)",
            ],
          }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}
      {executing && (
        <motion.div
          className="absolute bottom-0 left-0 h-[2px] bg-amber-400 rounded-full"
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: 30, ease: "linear" }}
        />
      )}
      <span className="relative z-10 flex items-center gap-2">
        {executing ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            执行中...
          </>
        ) : (
          <>
            <Rocket size={15} />
            执行到 {selectedCount} 台服务器
          </>
        )}
      </span>
    </motion.button>
  );
}

function ResultCard({
  result,
  index,
}: {
  result: ExecResult;
  index: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const cfg = {
    running: {
      border: "border-amber-500/25",
      bg: "bg-amber-500/[0.06]",
      icon: <Loader2 size={14} className="text-amber-400 animate-spin" />,
      label: "执行中",
      labelColor: "text-amber-400",
    },
    success: {
      border: "border-emerald-500/25",
      bg: "bg-emerald-500/[0.06]",
      icon: <CheckCircle2 size={14} className="text-emerald-400" />,
      label: "完成",
      labelColor: "text-emerald-400",
    },
    error: {
      border: "border-red-500/25",
      bg: "bg-red-500/[0.06]",
      icon: <XCircle size={14} className="text-red-400" />,
      label: "失败",
      labelColor: "text-red-400",
    },
  }[result.status];

  const output = result.stdout || result.stderr || "(无输出)";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", delay: index * 0.08 }}
      className={`rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden`}
    >
      <motion.div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        onClick={() => setExpanded(!expanded)}
        whileTap={{ scale: 0.99 }}
      >
        {cfg.icon}
        <span className="text-gray-800 dark:text-white/90 text-xs font-medium flex-1 truncate">
          {result.name || result.host}
        </span>
        <span className="text-gray-400 dark:text-white/45 text-[10px] font-mono mr-2">{result.host}</span>
        <span className={`text-[10px] font-medium ${cfg.labelColor}`}>{cfg.label}</span>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }}>
          <ChevronDown size={12} className="text-gray-400 dark:text-white/35" />
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <pre className="px-3 pb-3 pt-2 text-xs font-mono text-gray-600 dark:text-white/60 whitespace-pre-wrap max-h-40 overflow-y-auto border-t border-black/[0.04] dark:border-white/[0.06]">
              {output}
              {result.status === "running" && (
                <motion.span
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity }}
                  className="text-amber-400"
                >
                  ▍
                </motion.span>
              )}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>

      {result.status === "running" && (
        <motion.div
          className="h-[2px] bg-gradient-to-r from-amber-500 to-amber-300"
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: 60, ease: "linear" }}
        />
      )}
    </motion.div>
  );
}

function ToastContainer({ toasts }: { toasts: ToastData[] }) {
  const colors: Record<string, string> = {
    success:
      "from-emerald-500/15 to-emerald-600/5 dark:from-emerald-500/20 dark:to-emerald-600/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-300",
    error: "from-red-500/15 to-red-600/5 dark:from-red-500/20 dark:to-red-600/10 border-red-500/30 text-red-600 dark:text-red-300",
    info: "from-violet-500/15 to-violet-600/5 dark:from-violet-500/20 dark:to-violet-600/10 border-violet-500/30 text-violet-600 dark:text-violet-300",
  };

  return (
    <div className="fixed bottom-24 right-6 z-[999] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className={`px-4 py-2.5 rounded-xl backdrop-blur-2xl bg-gradient-to-r border text-sm shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] ${colors[t.type]}`}
          >
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ==================== Server Form Dialog ====================

function ServerFormDialog({
  open,
  editServer,
  onClose,
  onSave,
  onTest,
}: {
  open: boolean;
  editServer: ServerInfo | null;
  onClose: () => void;
  onSave: (server: ServerInfo) => void;
  onTest: (server: ServerInfo) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (editServer) {
      setName(editServer.name);
      setHost(editServer.host);
      setPort(String(editServer.port));
      setUsername(editServer.username);
      setAuthType(editServer.authType);
      setPassword(editServer.password || "");
      setKeyPath(editServer.keyPath || "");
    } else {
      setName("");
      setHost("");
      setPort("22");
      setUsername("root");
      setAuthType("password");
      setPassword("");
      setKeyPath("");
    }
    setShowPwd(false);
    setTesting(false);
  }, [editServer, open]);

  const buildServer = (): ServerInfo => ({
    id: editServer?.id || genId(),
    name: name || host,
    host,
    port: parseInt(port) || 22,
    username,
    authType,
    password: authType === "password" ? password : undefined,
    keyPath: authType === "key" ? keyPath : undefined,
  });

  const handleSave = () => {
    if (!host.trim()) return;
    onSave(buildServer());
    onClose();
  };

  const handleTest = async () => {
    if (!host.trim()) return;
    setTesting(true);
    onTest(buildServer());
    setTimeout(() => setTesting(false), 5000);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Dialog panel */}
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="pointer-events-auto w-full max-w-md mx-4 rounded-2xl bg-white/95 dark:bg-[#111827]/95 backdrop-blur-3xl border border-black/[0.08] dark:border-white/[0.10] shadow-[0_24px_80px_rgba(0,0,0,0.15)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.6)] p-5"
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 20 }}
              transition={{ type: "spring", stiffness: 400, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-semibold text-gray-800 dark:text-white/90">
                    {editServer ? "编辑服务器" : "添加服务器"}
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-white/50 mt-0.5">填写 SSH 连接信息</p>
                </div>
                <motion.button
                  whileHover={{ scale: 1.1, rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={onClose}
                  className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] flex items-center justify-center text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/70 hover:bg-black/[0.06] dark:hover:bg-white/[0.10] transition-colors"
                >
                  <XCircle size={14} />
                </motion.button>
              </div>

              {/* Form */}
              <div className="space-y-4">
                <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] border border-black/[0.04] dark:border-white/[0.06] p-3 space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">名称</Label>
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="prod-web"
                        className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30"
                      />
                    </div>
                    <div className="w-20">
                      <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">端口</Label>
                      <Input
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        placeholder="22"
                        className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">主机地址</Label>
                    <Input
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="192.168.1.100"
                      className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30"
                    />
                  </div>
                  <div>
                    <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">用户名</Label>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="root"
                      className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30"
                    />
                  </div>
                </div>

                <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] border border-black/[0.04] dark:border-white/[0.06] p-3 space-y-3">
                  <div className="flex gap-1 p-0.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04]">
                    <button
                      onClick={() => setAuthType("password")}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                        authType === "password"
                          ? "bg-white dark:bg-white/[0.12] text-gray-800 dark:text-white/90 shadow-sm"
                          : "text-gray-500 dark:text-white/45 hover:text-gray-700 dark:hover:text-white/70"
                      }`}
                    >
                      密码认证
                    </button>
                    <button
                      onClick={() => setAuthType("key")}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                        authType === "key"
                          ? "bg-white dark:bg-white/[0.12] text-gray-800 dark:text-white/90 shadow-sm"
                          : "text-gray-500 dark:text-white/45 hover:text-gray-700 dark:hover:text-white/70"
                      }`}
                    >
                      密钥认证
                    </button>
                  </div>

                  {authType === "password" ? (
                    <div className="relative">
                      <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">密码</Label>
                      <Input
                        type={showPwd ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="输入密码"
                        className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30 pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwd(!showPwd)}
                        className="absolute right-2 top-[26px] text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/70 transition-colors"
                      >
                        {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <Label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">私钥路径</Label>
                      <Input
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_rsa"
                        className="bg-white dark:bg-white/[0.07] border-black/[0.08] dark:border-white/[0.10] text-gray-800 dark:text-white/90 placeholder:text-gray-400 dark:placeholder:text-white/30"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 mt-4">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleTest}
                  disabled={!host.trim() || testing}
                  className="flex-1 py-2 rounded-xl text-sm font-medium text-gray-600 dark:text-white/70 bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.10] hover:bg-black/[0.06] dark:hover:bg-white/[0.10] transition-all disabled:opacity-30"
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {testing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Zap size={14} />
                    )}
                    测试连接
                  </span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleSave}
                  disabled={!host.trim()}
                  className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-violet-500/80 to-indigo-500/80 hover:from-violet-500 hover:to-indigo-500 border-0 shadow-[0_4px_16px_rgba(139,92,246,0.3)] transition-all disabled:opacity-30"
                >
                  {editServer ? "保存修改" : "添加服务器"}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ==================== Main Component ====================

export default function ServerHome() {
  const [servers, setServers] = useState<ServerInfo[]>(loadServers);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<ExecResult[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerInfo | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [serversCollapsed, setServersCollapsed] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveServers(servers);
  }, [servers]);

  const showToast = useCallback((message: string, type: ToastData["type"] = "info") => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const handleSaveServer = useCallback(
    (server: ServerInfo) => {
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === server.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = server;
          return next;
        }
        return [...prev, server];
      });
      showToast(
        editingServer ? `已更新「${server.name}」` : `已添加「${server.name}」`,
        "success"
      );
      setEditingServer(null);
    },
    [editingServer, showToast]
  );

  const handleTestServer = useCallback(
    async (server: ServerInfo) => {
      try {
        await invoke("test_ssh_connection", {
          server: {
            host: server.host,
            port: server.port,
            username: server.username,
            auth_type: server.authType,
            password: server.password || null,
            private_key_path: server.keyPath || null,
          },
        });
        showToast(`${server.host} 连接成功`, "success");
      } catch (err) {
        showToast(`${server.host} 连接失败: ${err}`, "error");
      }
    },
    [showToast]
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (pendingDeleteId === id) {
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        const s = servers.find((sv) => sv.id === id);
        setServers((prev) => prev.filter((sv) => sv.id !== id));
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setPendingDeleteId(null);
        showToast(`已删除「${s?.name || "服务器"}」`, "info");
        return;
      }
      setPendingDeleteId(id);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => setPendingDeleteId(null), 3000);
    },
    [pendingDeleteId, servers, showToast]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === servers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(servers.map((s) => s.id)));
    }
  }, [selectedIds.size, servers]);

  const handleExecute = useCallback(async () => {
    if (executing || selectedIds.size === 0 || !command.trim()) return;
    setExecuting(true);
    setServersCollapsed(true);

    const selectedServers = servers.filter((s) => selectedIds.has(s.id));
    const initialResults: ExecResult[] = selectedServers.map((s) => ({
      host: s.host,
      name: s.name,
      success: false,
      stdout: "",
      stderr: "",
      exit_code: null,
      status: "running",
    }));
    setResults(initialResults);

    const sessionId = genId();
    const eventName = `ssh-progress-${sessionId}`;

    const unlisten = await listen<{ host: string; status: string; message: string }>(
      eventName,
      (event) => {
        const p = event.payload;
        setResults((prev) =>
          prev.map((r) =>
            r.host === p.host
              ? {
                  ...r,
                  status: p.status === "success" ? "success" : p.status === "error" ? "error" : "running",
                }
              : r
          )
        );
      }
    );

    try {
      const sshServers = selectedServers.map((s) => ({
        host: s.host,
        port: s.port,
        username: s.username,
        auth_type: s.authType,
        password: s.password || null,
        private_key_path: s.keyPath || null,
      }));

      const res = await invoke<
        Array<{
          host: string;
          name: string;
          success: boolean;
          stdout: string;
          stderr: string;
          exit_code: number | null;
        }>
      >("execute_ssh_commands", {
        servers: sshServers,
        command: command.trim(),
        sessionId,
      });

      setResults(
        res.map((r, i) => ({
          ...r,
          name: selectedServers[i]?.name || r.host,
          status: r.success ? "success" : "error",
        }))
      );

      const successCount = res.filter((r) => r.success).length;
      const failCount = res.length - successCount;
      if (failCount === 0) {
        showToast(`全部 ${successCount} 台服务器执行成功`, "success");
      } else {
        showToast(`${successCount} 台成功, ${failCount} 台失败`, "error");
      }
    } catch (err) {
      showToast(`执行出错: ${err}`, "error");
      setResults((prev) =>
        prev.map((r) => (r.status === "running" ? { ...r, status: "error", stderr: String(err) } : r))
      );
    } finally {
      unlisten();
      setExecuting(false);
    }
  }, [executing, selectedIds, command, servers, showToast]);

  const handleImportConfig = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;

      const content = await invoke<string>("read_text_file", { path: selected });
      let imported: unknown;
      try {
        imported = JSON.parse(content);
      } catch {
        showToast("文件内容不是有效的 JSON 格式", "error");
        return;
      }

      if (!Array.isArray(imported) || imported.length === 0) {
        showToast("JSON 应为服务器数组，请参考模板格式", "error");
        return;
      }

      let addedCount = 0;
      const newServers: ServerInfo[] = [];

      for (const item of imported as Record<string, unknown>[]) {
        const host = String(item.host || "").trim();
        if (!host) continue;

        const isDuplicate = servers.some((s) => s.host === host && s.port === (Number(item.port) || 22));
        if (isDuplicate) continue;

        newServers.push({
          id: genId(),
          name: String(item.name || host),
          host,
          port: Number(item.port) || 22,
          username: String(item.username || "root"),
          authType: item.authType === "key" ? "key" : "password",
          password: item.authType === "key" ? undefined : String(item.password || ""),
          keyPath: item.authType === "key" ? String(item.keyPath || "") : undefined,
        });
        addedCount++;
      }

      if (addedCount === 0) {
        showToast("没有新服务器可导入（全部重复或格式无效）", "info");
        return;
      }

      setServers((prev) => [...prev, ...newServers]);
      showToast(`成功导入 ${addedCount} 台服务器`, "success");
    } catch (err) {
      showToast(`导入失败: ${err}`, "error");
    }
  }, [servers, showToast]);

  const handleExportConfig = useCallback(() => {
    const exportData = servers.map((s) => ({
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      authType: s.authType,
      ...(s.authType === "password" ? { password: s.password || "" } : { keyPath: s.keyPath || "" }),
    }));

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "servers-config.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${servers.length} 台服务器配置`, "success");
  }, [servers, showToast]);

  return (
    <div className="relative h-full w-full bg-transparent">
      <div
        ref={scrollRef}
        className="relative z-10 h-full overflow-y-auto px-5 pt-3 pb-20"
        style={{ scrollbarWidth: "thin" }}
      >
        {/* ===== Server Section (Collapsible) ===== */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <motion.div
              className="flex items-center gap-2.5 cursor-pointer select-none"
              onClick={() => servers.length > 0 && setServersCollapsed(!serversCollapsed)}
              whileTap={servers.length > 0 ? { scale: 0.98 } : {}}
            >
              <motion.div
                className="w-8 h-8 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] flex items-center justify-center"
                whileHover={{
                  boxShadow: "0 0 20px rgba(167,139,250,0.2), inset 0 0 8px rgba(167,139,250,0.1)",
                }}
                transition={{ duration: 0.4 }}
              >
                <Monitor size={16} className="text-gray-700 dark:text-white/80" />
              </motion.div>
              <span className="text-gray-800 dark:text-white/90 text-sm font-semibold">我的服务器</span>
              {servers.length > 0 && (
                <motion.span
                  key={servers.length}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 20 }}
                  className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-500/20 text-violet-600 dark:text-violet-300 border border-violet-500/20"
                >
                  {servers.length}
                </motion.span>
              )}
              {servers.length > 0 && (
                <motion.div
                  animate={{ rotate: serversCollapsed ? -90 : 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                >
                  <ChevronDown size={14} className="text-gray-400 dark:text-white/40" />
                </motion.div>
              )}
              {serversCollapsed && servers.length > 0 && (
                <motion.span
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-gray-400 dark:text-white/35 text-xs"
                >
                  已选 {selectedIds.size}/{servers.length}
                </motion.span>
              )}
            </motion.div>

            <div className="flex items-center gap-2">
              {servers.length > 0 && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleExportConfig}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-gray-500 dark:text-white/60 bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.10] hover:bg-black/[0.06] dark:hover:bg-white/[0.10] hover:text-gray-700 dark:hover:text-white/85 transition-all"
                >
                  <span className="flex items-center gap-1.5">
                    <Download size={13} />
                    导出
                  </span>
                </motion.button>
              )}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleImportConfig}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-gray-600 dark:text-white/70 bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.10] hover:bg-black/[0.06] dark:hover:bg-white/[0.10] hover:text-gray-800 dark:hover:text-white/90 transition-all"
              >
                <span className="flex items-center gap-1.5">
                  <Import size={13} />
                  导入
                </span>
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  setEditingServer(null);
                  setDialogOpen(true);
                }}
                className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-violet-700 dark:text-white/90 bg-gradient-to-r from-violet-500/15 dark:from-violet-500/25 to-indigo-500/15 dark:to-indigo-500/25 border border-violet-400/30 hover:from-violet-500/25 dark:hover:from-violet-500/35 hover:to-indigo-500/25 dark:hover:to-indigo-500/35 hover:border-violet-400/45 transition-all"
              >
                <span className="flex items-center gap-1.5">
                  <Plus size={14} />
                  添加
                </span>
              </motion.button>
            </div>
          </div>

          <div
            className="transition-[grid-template-rows] duration-[400ms] ease-in-out"
            style={{
              display: "grid",
              gridTemplateRows: serversCollapsed ? "0fr" : "1fr",
            }}
          >
            <div style={{ overflow: "hidden" }}>
              {servers.length === 0 ? (
                <EmptyState
                  onAdd={() => {
                    setEditingServer(null);
                    setDialogOpen(true);
                  }}
                />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 pt-2 pl-1 pr-1 pb-1">
                  <AnimatePresence mode="popLayout">
                    {servers.map((server, i) => (
                      <ServerCard
                        key={server.id}
                        server={server}
                        color={getColor(i)}
                        selected={selectedIds.has(server.id)}
                        index={i}
                        pendingDelete={pendingDeleteId === server.id}
                        onToggle={() => toggleSelect(server.id)}
                        onEdit={() => {
                          setEditingServer(server);
                          setDialogOpen(true);
                        }}
                        onDelete={() => handleDelete(server.id)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===== Command Section ===== */}
        {servers.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
              <div className="backdrop-blur-xl bg-white/70 dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.08] rounded-2xl p-5 mb-6 shadow-[0_4px_24px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.15)]">
              <SectionHeader icon={Terminal} title="执行命令" />
              <CommandInput value={command} onChange={setCommand} disabled={executing} />
              <div className="flex items-center justify-between mt-4">
                <SelectAllCheckbox
                  selected={selectedIds.size}
                  total={servers.length}
                  onToggle={toggleSelectAll}
                />
                <ExecuteButton
                  selectedCount={selectedIds.size}
                  executing={executing}
                  onExecute={handleExecute}
                />
              </div>
            </div>
          </motion.div>
        )}

        {/* ===== Results Section ===== */}
        <AnimatePresence>
          {results.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <div className="backdrop-blur-xl bg-white/70 dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.08] rounded-2xl p-5 shadow-[0_4px_24px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.15)]">
                <SectionHeader
                  icon={CheckCircle2}
                  title="执行结果"
                  count={results.filter((r) => r.status !== "running").length}
                />
                <div className="space-y-2">
                  {results.map((r, i) => (
                    <ResultCard key={`${r.host}-${i}`} result={r} index={i} />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ===== Dialog ===== */}
      <ServerFormDialog
        open={dialogOpen}
        editServer={editingServer}
        onClose={() => {
          setDialogOpen(false);
          setEditingServer(null);
        }}
        onSave={handleSaveServer}
        onTest={handleTestServer}
      />

      {/* ===== Toasts ===== */}
      <ToastContainer toasts={toasts} />
    </div>
  );
}
