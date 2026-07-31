import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  FolderOpen,
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  Settings2,
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { GlassCard, MiniField, glassInner, miniInputClass, type DeployStatus } from "./ui";

/**
 * H5 发版的配置不走 deploy-config-template.json，也不参与配置导入导出，
 * 默认值直接写在下面这个常量里。改默认值只需要改这一处。
 *
 * 界面上的修改会存进独立的 localStorage 键（见 H5_STORAGE_KEY），
 * 和其他部署项目的配置互不影响。
 */
export const H5_DEFAULT_CONFIG: H5Config = {
  dir: "",
  buildCommand: "npm run build:h5",
  cosRegion: "ap-beijing",
  cosBucket: "",
  cdnDomain: "",
};

/** 构建产物目录固定在项目根目录下的这个路径，界面上不可改 */
export const H5_DIST_DIR = "unpackage/dist/build/web";

export interface H5Config {
  /** H5 项目本地根目录 */
  dir: string;
  /** 打包命令，在 dir 下执行 */
  buildCommand: string;
  cosRegion: string;
  cosBucket: string;
  cdnDomain: string;
}

/** 复用部署会话机制时的标识，projectKey-envKey 要和模板项目区分开 */
export const H5_PROJECT_KEY = "__h5__";
export const H5_ENV_KEY = "prod";
export const H5_COMPOSITE_KEY = `${H5_PROJECT_KEY}-${H5_ENV_KEY}`;
export const H5_LABEL = "H5 项目";

const H5_STORAGE_KEY = "h5-deploy-config-v1";

export function loadH5Config(): H5Config {
  try {
    const raw = localStorage.getItem(H5_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          dir: typeof parsed.dir === "string" ? parsed.dir : H5_DEFAULT_CONFIG.dir,
          buildCommand:
            typeof parsed.buildCommand === "string"
              ? parsed.buildCommand
              : H5_DEFAULT_CONFIG.buildCommand,
          cosRegion:
            typeof parsed.cosRegion === "string" ? parsed.cosRegion : H5_DEFAULT_CONFIG.cosRegion,
          cosBucket:
            typeof parsed.cosBucket === "string" ? parsed.cosBucket : H5_DEFAULT_CONFIG.cosBucket,
          cdnDomain:
            typeof parsed.cdnDomain === "string" ? parsed.cdnDomain : H5_DEFAULT_CONFIG.cdnDomain,
        };
      }
    }
  } catch {}
  return { ...H5_DEFAULT_CONFIG };
}

export function saveH5Config(config: H5Config) {
  localStorage.setItem(H5_STORAGE_KEY, JSON.stringify(config));
}

// ==================== H5 Card ====================

export function H5Card({
  config,
  status,
  isRunning,
  onUpdate,
  onSelectDir,
  onReset,
  onDeploy,
}: {
  config: H5Config;
  status: DeployStatus;
  isRunning: boolean;
  onUpdate: (field: keyof H5Config, value: string) => void;
  onSelectDir: () => void;
  onReset: () => void;
  onDeploy: () => void;
}) {
  const [open, setOpen] = useState(false);

  const statusIcon = () => {
    if (isRunning) return <Loader2 className="size-3 animate-spin" />;
    if (status === "success") return <CheckCircle2 className="size-3" />;
    if (status === "error") return <XCircle className="size-3" />;
    return <Rocket className="size-3" />;
  };

  return (
    <GlassCard>
      <div className="flex items-center justify-between px-4 py-3 gap-2">
        <button
          onClick={() => setOpen(!open)}
          title={open ? "收起配置" : "展开配置"}
          className="flex items-center gap-2 min-w-0 cursor-pointer select-none"
        >
          <span
            className={`size-2 rounded-full shrink-0 ${
              isRunning
                ? "bg-amber-500 animate-pulse"
                : status === "success"
                ? "bg-emerald-500"
                : status === "error"
                ? "bg-red-500"
                : "bg-sky-500"
            }`}
          />
          <span className="text-[13px] font-semibold tracking-wide text-foreground/80 shrink-0">
            {H5_LABEL}
          </span>
          <Settings2 className="size-3.5 text-muted-foreground shrink-0" />
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform duration-300 shrink-0 ${
              open ? "rotate-180" : ""
            }`}
          />
          <span className="text-[10px] text-muted-foreground truncate">
            内置配置，不参与模板导入导出
          </span>
        </button>
        <div className="flex items-center shrink-0">
          <Button
            size="sm"
            onClick={onDeploy}
            disabled={isRunning}
            className={`gap-1 text-[11px] h-7 rounded-lg transition-all ${
              isRunning
                ? "bg-amber-500/80 text-white"
                : status === "success"
                ? "bg-emerald-500/80 text-white hover:bg-emerald-500/90"
                : status === "error"
                ? "bg-red-500/80 text-white hover:bg-red-500/90"
                : ""
            }`}
          >
            {statusIcon()}
            {isRunning ? "发版中..." : status === "success" ? "已完成" : status === "error" ? "重试" : "发版"}
          </Button>
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          open ? "max-h-[400px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className={`${glassInner} mx-3 mb-3 p-3 flex flex-col gap-2`}>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground w-[38px] shrink-0 text-right">目录</span>
            <input
              value={config.dir}
              onChange={(e) => onUpdate("dir", e.target.value)}
              placeholder="H5 项目本地路径"
              className={miniInputClass}
            />
            <Button variant="outline" size="xs" onClick={onSelectDir} className="shrink-0">
              <FolderOpen className="size-3 mr-1" />
              浏览
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground w-[38px] shrink-0 text-right">产物</span>
            <span
              className="flex-1 h-6 px-1.5 flex items-center text-[11px] font-mono rounded-md border border-dashed border-white/30 dark:border-white/[0.08] text-muted-foreground truncate"
              title="构建产物目录已固定，不可修改"
            >
              {H5_DIST_DIR}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <MiniField
              label="Build"
              value={config.buildCommand}
              onChange={(v) => onUpdate("buildCommand", v)}
              placeholder={H5_DEFAULT_CONFIG.buildCommand}
            />
            <MiniField
              label="Region"
              value={config.cosRegion}
              onChange={(v) => onUpdate("cosRegion", v)}
              placeholder="ap-beijing"
            />
            <MiniField
              label="Bucket"
              value={config.cosBucket}
              onChange={(v) => onUpdate("cosBucket", v)}
              placeholder="bucket-125xxx"
            />
            <MiniField
              label="域名"
              value={config.cdnDomain}
              onChange={(v) => onUpdate("cdnDomain", v)}
              placeholder="h5.example.com"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground leading-tight">
              打包在项目目录下执行上面的命令，产物固定取 {H5_DIST_DIR} 上传到 COS 并刷新预热 CDN；密钥与其他项目共用系统凭证管理器里的那一份
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={onReset}
              title="恢复内置默认配置"
              className="ml-auto shrink-0"
            >
              <RotateCcw className="size-3 mr-1" />
              恢复默认
            </Button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
