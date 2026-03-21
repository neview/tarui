import { useState, useEffect, useRef, useCallback } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { KuaishouCard } from "./KuaishouCard";
import { WxRibaoFormData } from "./KuaishouForm";
import { Alert, useAlert } from "@/components/ui/alert";
import { AnimatedList } from "@/components/ui/animated-list";
import styles from "./index.module.scss";

interface PyProcess {
  unlistenOut: UnlistenFn;
  unlistenErr: UnlistenFn;
}

export default function Kuaishou() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const processRef = useRef<PyProcess | null>(null);

  const cleanup = useCallback(() => {
    if (processRef.current) {
      processRef.current.unlistenOut();
      processRef.current.unlistenErr();
      processRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const handleFormSubmit = async (data: WxRibaoFormData) => {
    setLogs([]);

    const unlistenOut = await listen<string>("python-stdout", (event) => {
      setLogs((prev) => [...prev, event.payload]);
    });

    const unlistenErr = await listen<string>("python-stderr", (event) => {
      setLogs((prev) => [...prev, `[stderr] ${event.payload}`]);
    });

    processRef.current = { unlistenOut, unlistenErr };
    setLoading(true);

    const params = [
      `--outputFormat=${data.outputFormat}`,
      `--indentInTheLine=${data.indentInTheLine ? "True" : "False"}`,
      `--startDate=${data.startDate}`,
      `--endDate=${data.endDate}`,
    ];

    try {
      await invoke("run_wx_ribao", { params });
      showSuccess("脚本执行完成");
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      cleanup();
      processRef.current = null;
    }
  };

  const handleStop = async () => {
    try {
      await invoke("kill_python_script");
      showError("脚本已被停止");
    } catch {
      showError("停止命令不可用");
    } finally {
      setLoading(false);
      cleanup();
    }
  };

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className={`${styles.kuaishou_page} relative`}>
      <Alert alert={alert} onClose={closeAlert} />
      <div
        className={
          styles.content_row +
          " relative z-10 grid min-w-0 gap-6 [grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]"
        }
      >
        <div className="min-w-0">
          <KuaishouCard onSubmit={handleFormSubmit} onStop={handleStop} loading={loading} />
        </div>
        <div className="flex flex-col min-h-0 min-w-0">
          <AnimatedList logs={logs} title="运行日志" />
        </div>
      </div>
    </div>
  );
}
