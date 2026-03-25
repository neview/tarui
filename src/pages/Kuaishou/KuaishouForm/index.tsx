import { useState, type MouseEvent } from "react";

function openNativeDatePicker(e: MouseEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  if (typeof el.showPicker === "function") {
    try {
      el.showPicker();
    } catch {
      // 部分环境不支持或已在展示中
    }
  }
}
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Play, Square, Calendar } from "lucide-react";

export interface WxRibaoFormData {
  outputFormat: "1" | "2";
  indentInTheLine: boolean;
  startDate: string;
  endDate: string;
}

interface WxRibaoFormProps {
  onSubmit?: (data: WxRibaoFormData) => void;
  onCancel?: () => void;
  loading?: boolean;
}

interface FormErrors {
  startDate?: string;
  endDate?: string;
}

export function WxRibaoForm({ onSubmit, onCancel, loading }: WxRibaoFormProps) {
  const [outputFormat, setOutputFormat] = useState<"1" | "2">("1");
  const [indentInTheLine, setIndentInTheLine] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});

  const validate = (): boolean => {
    const newErrors: FormErrors = {};
    if (!startDate.trim()) {
      newErrors.startDate = "开始日期不能为空";
    }
    if (!endDate.trim()) {
      newErrors.endDate = "结束日期不能为空";
    } else if (startDate && endDate && startDate > endDate) {
      newErrors.endDate = "结束日期不能早于开始日期";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    if (onSubmit) {
      onSubmit({
        outputFormat,
        indentInTheLine,
        startDate,
        endDate,
      });
    }
  };

  const today = new Date().toISOString().split("T")[0];

  return (
    <form id="wxribao-form" onSubmit={handleSubmit} noValidate>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>输出格式</Label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="outputFormat"
                value="1"
                checked={outputFormat === "1"}
                onChange={() => setOutputFormat("1")}
              />
              <span className="text-sm">带序号</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="outputFormat"
                value="2"
                checked={outputFormat === "2"}
                onChange={() => setOutputFormat("2")}
              />
              <span className="text-sm">不带序号</span>
            </label>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="indentInTheLine" className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              id="indentInTheLine"
              checked={indentInTheLine}
              onChange={(e) => setIndentInTheLine(e.target.checked)}
            />
            <span>行内缩进</span>
          </Label>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="startDate">开始日期 *</Label>
          <div className="relative">
            <Input
              id="startDate"
              name="startDate"
              type="date"
              value={startDate}
              max={today}
              onClick={openNativeDatePicker}
              className={`cursor-pointer ${errors.startDate ? "border-red-500" : ""}`}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (errors.startDate) {
                  setErrors((prev) => ({ ...prev, startDate: undefined }));
                }
              }}
            />
            <Calendar className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          </div>
          {errors.startDate && (
            <p className="text-sm text-red-500">{errors.startDate}</p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="endDate">结束日期 *</Label>
          <div className="relative">
            <Input
              id="endDate"
              name="endDate"
              type="date"
              value={endDate}
              max={today}
              min={startDate}
              onClick={openNativeDatePicker}
              className={`cursor-pointer ${errors.endDate ? "border-red-500" : ""}`}
              onChange={(e) => {
                setEndDate(e.target.value);
                if (errors.endDate) {
                  setErrors((prev) => ({ ...prev, endDate: undefined }));
                }
              }}
            />
            <Calendar className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          </div>
          {errors.endDate && (
            <p className="text-sm text-red-500">{errors.endDate}</p>
          )}
        </div>

        {loading ? (
          <Button
            type="button"
            className="w-full bg-red-500 hover:bg-red-600"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCancel?.();
            }}
          >
            <Square className="h-4 w-4 mr-2" />
            取消执行
          </Button>
        ) : (
          <Button type="submit" className="w-full">
            <Play className="h-4 w-4 mr-2" />
            获取日报
          </Button>
        )}
      </div>
    </form>
  );
}
