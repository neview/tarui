import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarCheck,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Plus,
  Smartphone,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShineBorder } from "@/components/ui/shine-border";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { logOperation } from "@/utils/operationLog";
import { cn } from "@/lib/utils";
import styles from "./index.module.scss";

const LOG_PAGE = "checkin";
const LOG_PAGE_LABEL = "积分签到";
const STORAGE_KEY = "checkin-accounts-v1";
const MAX_ACCOUNTS = 3;
const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{4,6}$/;
const ACCOUNT_GAP_MS = 5000;
const CONFIG_FIELDS: [string, string][] = [
  ["AES_KEY", "密码加密 AES 密钥"],
  ["AES_IV", "AES 初始向量 IV"],
  ["APP_APPID", "APP 端 appId"],
  ["APP_SIGN_KEY", "APP 端签名密钥"],
  ["APP_SIGN_SALT", "APP 端签名盐"],
  ["H5_APPID", "H5 端 appId"],
  ["H5_SIGN_KEY", "H5 端签名密钥"],
  ["DEVICE_ID", "设备指纹 deviceId"],
];

interface MixcConfigInfo {
  path: string;
  content: string;
  exists: boolean;
}

interface MixcCliResult {
  status: "success" | "device_limited" | "error" | string;
  account?: string;
  message?: string;
  points?: string | number | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseConfig(text: string) {
  const conf: Record<string, string> = {};
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
    const index = trimmed.indexOf("=");
    conf[trimmed.slice(0, index).trim().toUpperCase()] = trimmed.slice(index + 1).trim();
  });
  return conf;
}

function missingConfigFields(text: string) {
  const conf = parseConfig(text);
  return CONFIG_FIELDS.filter(([key]) => !conf[key]).map(([, label]) => label);
}

type LoginMode = "password" | "sms";

interface CheckinAccount {
  id: string;
  account: string;
  password: string;
  phone: string;
  code: string;
  /** password：账号密码登录；sms：手机验证码登录（含设备限制后的自动切换） */
  loginMode: LoginMode;
  /** 登录接口返回设备限制后置为 true */
  deviceLimited: boolean;
  codeCooldown: number;
}

interface PersistedAccount {
  id: string;
  account: string;
  phone: string;
  loginMode: LoginMode;
  deviceLimited: boolean;
}

interface FieldErrors {
  account?: string;
  password?: string;
  phone?: string;
  code?: string;
}

interface CheckinResult {
  title: string;
  message: string;
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `acc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createAccount(): CheckinAccount {
  return {
    id: createId(),
    account: "",
    password: "",
    phone: "",
    code: "",
    loginMode: "password",
    deviceLimited: false,
    codeCooldown: 0,
  };
}

function isBlank(item: CheckinAccount) {
  return !item.account.trim() && !item.password && !item.phone.trim() && !item.code.trim();
}

function maskPhone(phone: string) {
  const value = phone.trim();
  if (value.length < 7) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function accountLabel(item: CheckinAccount, index: number) {
  if (item.account.trim()) return item.account.trim();
  if (item.phone.trim()) return maskPhone(item.phone);
  return `账号 ${index + 1}`;
}

function loadAccounts(): CheckinAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createAccount()];
    const parsed = JSON.parse(raw) as PersistedAccount[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [createAccount()];
    return parsed.slice(0, MAX_ACCOUNTS).map((item) => ({
      id: item.id || createId(),
      account: item.account ?? "",
      password: "",
      phone: item.phone ?? "",
      code: "",
      loginMode: item.loginMode === "sms" ? "sms" : "password",
      deviceLimited: Boolean(item.deviceLimited) && item.loginMode === "sms",
      codeCooldown: 0,
    }));
  } catch {
    return [createAccount()];
  }
}

export default function Checkin() {
  const [accounts, setAccounts] = useState<CheckinAccount[]>(loadAccounts);
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  const [result, setResult] = useState<CheckinResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [configText, setConfigText] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [configReady, setConfigReady] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(accounts.length);

  useEffect(() => {
    const payload: PersistedAccount[] = accounts.map((item) => ({
      id: item.id,
      account: item.account,
      phone: item.phone,
      loginMode: item.loginMode,
      deviceLimited: item.deviceLimited,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [accounts]);

  const applyConfigInfo = (info: MixcConfigInfo) => {
    setConfigText(info.content);
    setConfigPath(info.path);
    setConfigReady(info.exists && missingConfigFields(info.content).length === 0);
  };

  useEffect(() => {
    invoke<MixcConfigInfo>("get_mixc_config").then(applyConfigInfo).catch(() => {});
  }, []);

  const cooling = accounts.some((item) => item.codeCooldown > 0);
  useEffect(() => {
    if (!cooling) return;
    const timer = window.setInterval(() => {
      setAccounts((prev) => {
        if (!prev.some((item) => item.codeCooldown > 0)) return prev;
        return prev.map((item) =>
          item.codeCooldown > 0 ? { ...item, codeCooldown: item.codeCooldown - 1 } : item
        );
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooling]);

  useEffect(() => {
    if (accounts.length > prevCountRef.current) {
      const list = listRef.current;
      const last = list?.lastElementChild;
      last?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    prevCountRef.current = accounts.length;
  }, [accounts.length]);

  const updateAccount = (id: string, patch: Partial<CheckinAccount>) => {
    setAccounts((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setErrors((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const next = { ...current };
      (Object.keys(patch) as (keyof FieldErrors)[]).forEach((key) => {
        if (key in next) delete next[key];
      });
      return { ...prev, [id]: next };
    });
  };

  const changeMode = (id: string, mode: LoginMode) => {
    setAccounts((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              loginMode: mode,
              deviceLimited: mode === "password" ? false : item.deviceLimited,
            }
          : item
      )
    );
    setErrors((prev) => ({ ...prev, [id]: {} }));
  };

  const addAccount = () => {
    setAccounts((prev) => (prev.length >= MAX_ACCOUNTS ? prev : [...prev, createAccount()]));
  };

  const removeAccount = (id: string) => {
    setAccounts((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item.id !== id)));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const validate = () => {
    const nextErrors: Record<string, FieldErrors> = {};
    const filled = accounts.filter((item) => !isBlank(item));
    if (filled.length === 0) {
      const first = accounts[0];
      nextErrors[first.id] =
        first.loginMode === "password"
          ? { account: "请至少填写一个账号" }
          : { phone: "请至少填写一个账号" };
      setErrors(nextErrors);
      return false;
    }

    let valid = true;
    accounts.forEach((item) => {
      if (isBlank(item)) return;
      const fieldErrors: FieldErrors = {};
      if (item.loginMode === "password") {
        if (!item.account.trim()) fieldErrors.account = "请输入账号";
      } else {
        if (!PHONE_RE.test(item.phone.trim())) fieldErrors.phone = "请输入 11 位手机号";
        if (!CODE_RE.test(item.code.trim())) fieldErrors.code = "请输入 4-6 位验证码";
      }
      if (Object.keys(fieldErrors).length > 0) {
        nextErrors[item.id] = fieldErrors;
        valid = false;
      }
    });

    setErrors(nextErrors);
    return valid;
  };

  const ensureConfig = () => {
    if (configReady) return true;
    setResult({
      title: "还没有配置",
      message: "请先点「配置信息」，导入 mixc_config.txt，或自己把配置内容贴进去保存。",
    });
    return false;
  };

  const requestSmsCode = async (item: CheckinAccount) => {
    if (running) return;
    const phone = item.phone.trim();
    if (!PHONE_RE.test(phone)) {
      setErrors((prev) => ({
        ...prev,
        [item.id]: { ...prev[item.id], phone: "请输入 11 位手机号" },
      }));
      return;
    }
    if (!ensureConfig()) return;

    const index = accounts.findIndex((account) => account.id === item.id);
    const name = accountLabel(item, index);
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「获取验证码」",
      status: "info",
      detail: name,
    });
    try {
      const res = await invoke<MixcCliResult>("run_mixc", {
        params: { action: "send-code", account: phone, password: "", code: "" },
      });
      if (res.status === "success") {
        setAccounts((prev) =>
          prev.map((account) => (account.id === item.id ? { ...account, codeCooldown: 60 } : account))
        );
        setResult({ title: "验证码已发送", message: `「${name}」的验证码已发送，请填写后再执行签到。` });
      } else {
        setResult({ title: "验证码未发送", message: res.message || `「${name}」验证码发送失败` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ title: "验证码未发送", message });
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (running) return;
    if (!ensureConfig()) return;
    if (!validate()) {
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「执行积分签到」",
        status: "error",
        detail: "表单未填写完整",
      });
      setResult({
        title: "无法签到",
        message: "请先补全需要执行的账号信息。",
      });
      return;
    }

    const ready = accounts.filter((item) => !isBlank(item));
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「执行积分签到」",
      status: "info",
      detail: `依次执行 ${ready.length} 个账号`,
    });

    setRunning(true);
    const lines: string[] = [];
    let hasProblem = false;
    try {
      for (let i = 0; i < ready.length; i += 1) {
        if (i > 0) {
          setProgress(`等待 5 秒后执行下一个账号（${i + 1}/${ready.length}）`);
          await sleep(ACCOUNT_GAP_MS);
        }
        const item = ready[i];
        const name = accountLabel(item, accounts.findIndex((account) => account.id === item.id));
        const loginAccount = item.loginMode === "sms" ? item.phone.trim() : item.account.trim();
        setProgress(`正在签到 ${i + 1}/${ready.length}：${name}`);
        try {
          const res = await invoke<MixcCliResult>("run_mixc", {
            params: {
              action: "sign",
              account: loginAccount,
              password: item.loginMode === "password" ? item.password : "",
              code: item.loginMode === "sms" ? item.code.trim() : "",
            },
          });
          if (res.status === "device_limited") {
            hasProblem = true;
            setAccounts((prev) =>
              prev.map((account) =>
                account.id === item.id
                  ? {
                      ...account,
                      loginMode: "sms",
                      deviceLimited: true,
                      phone: account.phone.trim() || loginAccount,
                    }
                  : account
              )
            );
            lines.push(`「${name}」遇到设备限制，已切换为手机验证码。请获取验证码后重新执行。`);
          } else if (res.status === "success") {
            const points = res.points === undefined || res.points === null ? "" : `，剩余积分 ${res.points}`;
            lines.push(`「${name}」签到成功${points}`);
          } else {
            hasProblem = true;
            lines.push(`「${name}」${res.message || "签到失败"}`);
          }
        } catch (error) {
          hasProblem = true;
          const message = error instanceof Error ? error.message : String(error);
          lines.push(`「${name}」${message}`);
        }
      }
    } finally {
      setRunning(false);
      setProgress("");
    }

    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "执行积分签到",
      status: hasProblem ? "error" : "success",
      detail: lines.join("；"),
    });
    setResult({
      title: hasProblem ? "签到结束" : "签到完成",
      message: lines.join("\n"),
    });
  };

  const saveConfig = async (content: string) => {
    const path = await invoke<string>("save_mixc_config", { content });
    setConfigPath(path);
    setConfigText(content);
    setConfigReady(missingConfigFields(content).length === 0);
    return path;
  };

  const importConfigFile = async () => {
    const selected = await open({
      multiple: false,
      title: "导入配置文件",
      filters: [{ name: "配置文件", extensions: ["txt"] }],
    });
    if (typeof selected !== "string") return;
    const content = await invoke<string>("read_text_file", { path: selected });
    setConfigText(content);
  };

  return (
    <div className={styles.checkin_page}>
      <form className="flex w-full min-w-0 flex-col" onSubmit={handleSubmit} noValidate>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-medium leading-snug text-foreground">积分签到</h2>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={() => setConfigOpen(true)}>
              <FileUp className="h-4 w-4" />
              配置信息
            </Button>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              disabled={running || accounts.length >= MAX_ACCOUNTS}
              onClick={addAccount}
            >
              <Plus className="h-4 w-4" />
              添加账号
            </Button>
            <Button type="submit" className="cursor-pointer" disabled={running}>
              <CalendarCheck className="h-4 w-4" />
              {running ? "签到中..." : "执行积分签到"}
            </Button>
          </div>
        </div>
        {progress && <p className="mb-2 text-xs text-muted-foreground">{progress}</p>}

        <div ref={listRef} className={styles.account_list}>
          <AnimatePresence initial={false}>
            {accounts.map((item, index) => (
              <AccountCard
                key={item.id}
                index={index}
                total={accounts.length}
                account={item}
                errors={errors[item.id]}
                onChange={(patch) => updateAccount(item.id, patch)}
                onMode={(mode) => changeMode(item.id, mode)}
                onRemove={() => removeAccount(item.id)}
                onRequestCode={() => requestSmsCode(item)}
                busy={running}
              />
            ))}
          </AnimatePresence>
        </div>
      </form>

      <Dialog open={result !== null} onOpenChange={(open) => { if (!open) setResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{result?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap">{result?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" className="cursor-pointer" onClick={() => setResult(null)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>配置信息</DialogTitle>
            <DialogDescription>
              导入 mixc_config.txt，或直接把配置内容贴在下面保存。账号和密码在页面上填写，不写进这个文件。
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={configText}
            spellCheck={false}
            placeholder={"AES_KEY=\nAES_IV=\nAPP_APPID=\nAPP_SIGN_KEY=\nAPP_SIGN_SALT=\nH5_APPID=\nH5_SIGN_KEY=\nDEVICE_ID="}
            className="h-52 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => setConfigText(event.target.value)}
          />
          {missingConfigFields(configText).length > 0 && (
            <p className="text-xs text-red-500">
              还缺：{missingConfigFields(configText).join("、")}
            </p>
          )}
          {configPath && (
            <p className="truncate text-[11px] text-muted-foreground" title={configPath}>
              {configReady ? "已保存" : "未保存完整配置"}：{configPath}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" className="cursor-pointer" onClick={() => importConfigFile().catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              setResult({ title: "导入失败", message });
            })}>
              导入文件
            </Button>
            <Button
              type="button"
              className="cursor-pointer"
              onClick={() => {
                saveConfig(configText)
                  .then(() => {
                    if (missingConfigFields(configText).length === 0) setConfigOpen(false);
                  })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setResult({ title: "保存失败", message });
                  });
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountCard({
  index,
  total,
  account,
  errors,
  onChange,
  onMode,
  onRemove,
  onRequestCode,
  busy,
}: {
  index: number;
  total: number;
  account: CheckinAccount;
  errors?: FieldErrors;
  onChange: (patch: Partial<CheckinAccount>) => void;
  onMode: (mode: LoginMode) => void;
  onRemove: () => void;
  onRequestCode: () => void;
  busy?: boolean;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const passwordMode = account.loginMode === "password";

  return (
    <motion.section
      layout
      id={`checkin-account-${account.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className={styles.account_card}
    >
      <div className="relative isolate w-full overflow-hidden rounded-xl">
        <ShineBorder
          borderWidth={2}
          duration={14}
          shineColor={account.deviceLimited ? ["#f59e0b", "#f4d35e", "#f59e0b"] : ["#f7d047", "#50c9ff", "#f7d047"]}
          className="rounded-xl"
        />
        <div className="relative z-10 rounded-xl bg-card px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-border pb-3">
        <h3 className="text-base font-medium leading-snug text-foreground">账号 {index + 1}</h3>
        {total > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer text-muted-foreground hover:text-red-500"
            aria-label={`删除账号 ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mb-4 inline-flex w-full rounded-lg border border-border bg-card p-0.5">
        <ModeButton
          active={passwordMode}
          icon={<KeyRound className="size-3.5" />}
          label="账号密码"
          onClick={() => onMode("password")}
        />
        <ModeButton
          active={!passwordMode}
          icon={<Smartphone className="size-3.5" />}
          label="手机验证码"
          onClick={() => onMode("sms")}
        />
      </div>

      {account.deviceLimited && (
        <div className="mb-2 rounded-md border border-amber-300/80 bg-amber-100/70 px-2 py-1 text-[11px] leading-relaxed text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
          登录遇到设备限制，已切换为手机验证码。请获取验证码并填写后，再执行积分签到。
        </div>
      )}

      {passwordMode ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`checkin-account-${account.id}-name`}>账号 *</Label>
            <Input
              id={`checkin-account-${account.id}-name`}
              value={account.account}
              autoComplete="off"
              spellCheck={false}
              placeholder="请输入账号"
              className={errors?.account ? "border-red-500" : ""}
              onChange={(event) => onChange({ account: event.target.value })}
            />
            <FieldError message={errors?.account} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`checkin-password-${account.id}`}>密码</Label>
            <div className="relative">
              <Input
                id={`checkin-password-${account.id}`}
                type={showPassword ? "text" : "password"}
                value={account.password}
                autoComplete="new-password"
                placeholder="留空则使用已保存的登录状态"
                className={cn("pr-8", errors?.password ? "border-red-500" : "")}
                onChange={(event) => onChange({ password: event.target.value })}
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <FieldError message={errors?.password} />
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`checkin-phone-${account.id}`}>手机号 *</Label>
            <Input
              id={`checkin-phone-${account.id}`}
              inputMode="numeric"
              autoComplete="off"
              maxLength={11}
              value={account.phone}
              placeholder="请输入手机号"
              className={errors?.phone ? "border-red-500" : ""}
              onChange={(event) => onChange({ phone: event.target.value.replace(/\D/g, "").slice(0, 11) })}
            />
            <FieldError message={errors?.phone} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`checkin-code-${account.id}`}>验证码 *</Label>
            <div className="flex gap-2">
              <Input
                id={`checkin-code-${account.id}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={account.code}
                placeholder="请输入验证码"
                className={cn("min-w-0 flex-1", errors?.code ? "border-red-500" : "")}
                onChange={(event) => onChange({ code: event.target.value.replace(/\D/g, "").slice(0, 6) })}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 cursor-pointer"
                disabled={busy || account.codeCooldown > 0}
                onClick={onRequestCode}
              >
                {account.codeCooldown > 0 ? `${account.codeCooldown}s` : "获取验证码"}
              </Button>
            </div>
            <FieldError message={errors?.code} />
          </div>
        </div>
      )}
        </div>
      </div>
    </motion.section>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-500">{message}</p>;
}
