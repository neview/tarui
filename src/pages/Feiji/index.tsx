import { useState } from "react";
import { ReleaseCard } from "./ReleaseCard";
import { ReleaseFormData } from "./ReleaseForm";
import { releaseVersion } from "@/utils/api";
import { Alert, useAlert } from "@/components/ui/alert";
import { AnimatedList } from "@/components/ui/animated-list";
import styles from "./index.module.scss";

export default function Feiji() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [logs, setLogs] = useState<string[]>([]);

  const handleFormSubmit = async (data: ReleaseFormData) => {
    // 清空之前的日志
    setLogs([]);
    try {
      const result = await releaseVersion(data);
      // 始终显示 message，根据 code 判断成功或失败
      if (result.code === 1) {
        showSuccess(result.message);
      } else {
        showError(result.message);
      }
      // 设置日志
      if (result.log && result.log.length > 0) {
        setLogs([...result.log].reverse());
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "请求失败，请稍后重试");
    }
  };

  return (
    <div style={{ padding: "10px 10px 30px 10px" }} className={styles.feiji_page}>
      <Alert alert={alert} onClose={closeAlert} />
      <div className="flex gap-6 h-full">
        <div className="flex-1">
          <ReleaseCard onSubmit={handleFormSubmit} />
        </div>
        <div className="flex-1">
          <AnimatedList logs={logs} title="执行日志" />
        </div>
      </div>
    </div>
  );
}
