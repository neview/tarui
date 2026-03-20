import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

export interface AlertMessage {
  type: "success" | "error";
  title?: string;
  message: string;
}

interface AlertProps {
  alert: AlertMessage | null;
  onClose?: () => void;
  duration?: number;
}

export function Alert({ alert, onClose, duration = 5000 }: AlertProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (alert) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => onClose?.(), 300);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [alert, duration, onClose]);

  if (!alert) return null;

  const isSuccess = alert.type === "success";

  return (
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
      }`}
    >
      <div
        className={`flex items-start gap-3 p-4 rounded-lg shadow-lg border ${
          isSuccess
            ? "bg-green-50 border-green-200 text-green-800"
            : "bg-red-50 border-red-200 text-red-800"
        }`}
        style={{ maxWidth: "360px" }}
      >
        {isSuccess ? (
          <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
        ) : (
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          {alert.title && (
            <p className="font-semibold text-sm">{alert.title}</p>
          )}
          <p className="text-sm">{alert.message}</p>
        </div>
        <button
          onClick={() => {
            setVisible(false);
            setTimeout(() => onClose?.(), 300);
          }}
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function useAlert() {
  const [alert, setAlert] = useState<AlertMessage | null>(null);

  const showAlert = (type: AlertMessage["type"], message: string, title?: string) => {
    setAlert({ type, message, title });
  };

  const showSuccess = (message: string, title?: string) => {
    showAlert("success", message, title);
  };

  const showError = (message: string, title?: string) => {
    showAlert("error", message, title);
  };

  const closeAlert = () => {
    setAlert(null);
  };

  return { alert, showAlert, showSuccess, showError, closeAlert };
}
