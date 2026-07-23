import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Terminal } from "lucide-react";

interface AnimatedListProps {
  /** 时间正序（最早在前）传入即可；组件内部会以「最新在最上面」的顺序展示 */
  logs: string[];
  title?: string;
  /** 是否在新增日志时自动滚动（最新在顶部，这里滚动到顶部） */
  autoScroll?: boolean;
}

export function AnimatedList({
  logs,
  title = "执行日志",
  autoScroll = true,
}: AnimatedListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新日志到来时滚动到顶部（最新日志所在位置）
  useEffect(() => {
    if (autoScroll && logs.length > 0) {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  // 保持原始追加顺序的稳定索引作为 key（避免倒序导致的 key 抖动、整列表重渲染），
  // 仅在展示时倒序，使最新的一条位于最上面。
  const view = logs.map((log, i) => ({ log, i })).reverse();

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <Terminal className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <span className="text-xs text-muted-foreground/60">({logs.length})</span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-[280px] overflow-y-auto rounded-xl p-2 space-y-2 bg-transparent"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {view.length === 0 ? (
            <motion.div
              key="__empty__"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-xl border border-border bg-card/50 px-4 py-6 text-center text-sm text-muted-foreground"
            >
              执行操作后将显示日志...
            </motion.div>
          ) : (
            view.map(({ log, i }, pos) => (
              <motion.div
                key={`${i}-${log.slice(0, 20)}`}
                initial={{ opacity: 0, y: -12, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm hover:shadow-md transition-shadow text-left"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <Terminal className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="text-sm font-medium text-foreground break-all">
                    {log}
                  </p>
                  <span className="text-xs text-muted-foreground mt-0.5 inline-block">
                    #{String(pos + 1).padStart(2, "0")}
                  </span>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
