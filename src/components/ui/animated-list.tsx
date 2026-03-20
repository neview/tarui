import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Terminal } from "lucide-react";

interface AnimatedListProps {
  logs: string[];
  title?: string;
}

export function AnimatedList({ logs, title = "执行日志" }: AnimatedListProps) {
  const [displayLogs, setDisplayLogs] = useState<string[]>([]);

  useEffect(() => {
    if (logs.length === 0) {
      setDisplayLogs([]);
      return;
    }

    logs.forEach((log, index) => {
      const timer = setTimeout(() => {
        setDisplayLogs((prev) => [...prev, log]);
      }, index * 120);
      return () => clearTimeout(timer);
    });
  }, [logs]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <Terminal className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <span className="text-xs text-muted-foreground/60">({displayLogs.length})</span>
      </div>

      <div className="flex-1 min-h-[280px] overflow-y-auto rounded-xl p-2 space-y-2 bg-transparent">
        <AnimatePresence mode="popLayout">
          {displayLogs.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-xl border border-border bg-card/50 px-4 py-6 text-center text-sm text-muted-foreground"
            >
              执行操作后将显示日志...
            </motion.div>
          ) : (
            displayLogs.map((log, index) => (
              <motion.div
                key={`${index}-${log.slice(0, 20)}`}
                initial={{ opacity: 0, y: 12, scale: 0.96 }}
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
                    #{String(index + 1).padStart(2, "0")}
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
