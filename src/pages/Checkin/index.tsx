import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarCheck,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  LogOut,
  Plus,
  Smartphone,
  Trash2,
} from "lucide-react";
import { OperationLogButton } from "@/components/OperationLog";
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
const ACCENTS = [
  "from-violet-500 to-indigo-500",
  "from-amber-500 to-orange-500",
  "from-sky-500 to-cyan-500",
];

interface MixcConfigInfo {
  path: string;
  content: string;
  exists: boolean;
}

interface MixcCliResult {
  status: "success" | "device_limited" | "error" | "logged_in" | "logged_out" | string;
  account?: string;
  message?: string;
  loggedIn?: boolean;
  points?: string | number | null;
  lastSignPoints?: string | number | null;
  signedToday?: boolean | null;
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
  loginMode: LoginMode;
  deviceLimited: boolean;
  codeCooldown: number;
  loggedIn: boolean;
  points: string | number | null;
  lastSignPoints: string | number | null;
  signedToday: boolean | null;
}

interface PersistedAccount {
  id: string;
  account: string;
  phone: string;
  loginMode: LoginMode;
  deviceLimited: boolean;
  loggedIn?: boolean;
  points?: string | number | null;
  lastSignPoints?: string | number | null;
  signedToday?: boolean | null;
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
    loggedIn: false,
    points: null,
    lastSignPoints: null,
    signedToday: null,
  };
}

function hasPoints(points: string | number | null | undefined) {
  return points !== undefined && points !== null && points !== "";
}

function showValue(points: string | number | null | undefined) {
  return hasPoints(points) ? String(points) : "--";
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

function sessionAccount(item: CheckinAccount) {
  return item.account.trim() || item.phone.trim();
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
      loggedIn: Boolean(item.loggedIn),
      points: hasPoints(item.points) ? item.points ?? null : null,
      lastSignPoints: hasPoints(item.lastSignPoints) ? item.lastSignPoints ?? null : null,
      signedToday: typeof item.signedToday === "boolean" ? item.signedToday : null,
    }));
  } catch {
    return [createAccount()];
  }
}

function mergeResult(account: CheckinAccount, res: MixcCliResult): CheckinAccount {
  const loggedOut = res.status === "logged_out";
  const loggedIn = loggedOut
    ? false
    : res.status === "logged_in" || res.loggedIn === true || res.status === "success"
      ? true
      : account.loggedIn;
  return {
    ...account,
    loggedIn,
    points: hasPoints(res.points) ? res.points ?? null : account.points,
    lastSignPoints: hasPoints(res.lastSignPoints) ? res.lastSignPoints ?? null : account.lastSignPoints,
    signedToday: typeof res.signedToday === "boolean" ? res.signedToday : account.signedToday,
    code: loggedIn ? "" : account.code,
    password: loggedIn ? "" : account.password,
  };
}

const glassCard =
  "relative overflow-hidden rounded-2xl bg-white/60 backdrop-blur-2xl backdrop-saturate-150 dark:bg-white/[0.035] shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_0_0_1px_rgba(255,255,255,0.15)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(255,255,255,0.035)]";

const ghostButton =
  "h-7 px-2.5 rounded-lg bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.10] text-gray-700 dark:text-white/70 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed";

const primaryButton =
  "h-8 px-3 rounded-lg bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shadow-[0_0_12px_rgba(139,92,246,0.35)] disabled:opacity-40 disabled:cursor-not-allowed";

function fieldClass(invalid?: string) {
  return cn(
    "h-8 w-full rounded-lg border bg-white/80 px-2.5 text-xs text-gray-800 outline-none transition-colors dark:bg-white/5 dark:text-white/90",
    invalid
      ? "border-red-500 ring-2 ring-red-500/20"
      : "border-black/10 focus:border-violet-400 dark:border-white/15"
  );
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
  const [syncing, setSyncing] = useState(false);
  const accountsRef = useRef(accounts);
  const syncedRef = useRef(false);
  accountsRef.current = accounts;

  useEffect(() => {
    const payload: PersistedAccount[] = accounts.map((item) => ({
      id: item.id,
      account: item.account,
      phone: item.phone,
      loginMode: item.loginMode,
      deviceLimited: item.deviceLimited,
      loggedIn: item.loggedIn,
      points: item.points,
      lastSignPoints: item.lastSignPoints,
      signedToday: item.signedToday,
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

  const ensureConfig = () => {
    if (configReady) return true;
    setResult({
      title: "还没有配置",
      message: "请先点「配置信息」，导入 mixc_config.txt，或自己把配置内容贴进去保存。",
    });
    return false;
  };

  const applyRemote = (id: string, res: MixcCliResult) => {
    setAccounts((prev) => prev.map((account) => (account.id === id ? mergeResult(account, res) : account)));
  };

  useEffect(() => {
    if (!configReady || syncedRef.current) return;
    syncedRef.current = true;
    const targets = accountsRef.current.filter((item) => sessionAccount(item));
    if (targets.length === 0) return;
    let cancelled = false;
    setSyncing(true);
    (async () => {
      try {
        for (const item of targets) {
          if (cancelled) return;
          try {
            const res = await invoke<MixcCliResult>("run_mixc", {
              params: { action: "session", account: sessionAccount(item), password: "", code: "" },
            });
            if (!cancelled) applyRemote(item.id, res);
          } catch {
            // 打不开会话时保留页面上已有的登录展示
          }
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configReady]);

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
          ? { ...item, loginMode: mode, deviceLimited: mode === "password" ? false : item.deviceLimited }
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

  const validateLogin = (item: CheckinAccount) => {
    const fieldErrors: FieldErrors = {};
    if (item.loginMode === "password") {
      if (!item.account.trim()) fieldErrors.account = "请输入账号";
      if (!item.password) fieldErrors.password = "请输入密码";
    } else {
      if (!PHONE_RE.test(item.phone.trim())) fieldErrors.phone = "请输入 11 位手机号";
      if (!CODE_RE.test(item.code.trim())) fieldErrors.code = "请输入 4-6 位验证码";
    }
    setErrors((prev) => ({ ...prev, [item.id]: fieldErrors }));
    return Object.keys(fieldErrors).length === 0;
  };

  const requestSmsCode = async (item: CheckinAccount) => {
    if (running) return;
    const phone = item.phone.trim();
    if (!PHONE_RE.test(phone)) {
      setErrors((prev) => ({ ...prev, [item.id]: { ...prev[item.id], phone: "请输入 11 位手机号" } }));
      return;
    }
    if (!ensureConfig()) return;
    const index = accounts.findIndex((account) => account.id === item.id);
    const name = accountLabel(item, index);
    logOperation({ page: LOG_PAGE, pageLabel: LOG_PAGE_LABEL, action: "点击「获取验证码」", status: "info", detail: name });
    try {
      const res = await invoke<MixcCliResult>("run_mixc", {
        params: { action: "send-code", account: phone, password: "", code: "" },
      });
      if (res.status === "success") {
        setAccounts((prev) => prev.map((account) => (account.id === item.id ? { ...account, codeCooldown: 60 } : account)));
        setResult({ title: "验证码已发送", message: `「${name}」的验证码已发送，填写后点登录。` });
      } else {
        setResult({ title: "验证码未发送", message: res.message || `「${name}」验证码发送失败` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ title: "验证码未发送", message });
    }
  };

  const loginAccount = async (item: CheckinAccount) => {
    if (running) return;
    if (!ensureConfig() || !validateLogin(item)) return;
    const index = accounts.findIndex((account) => account.id === item.id);
    const name = accountLabel(item, index);
    const loginId = item.loginMode === "sms" ? item.phone.trim() : item.account.trim();
    logOperation({ page: LOG_PAGE, pageLabel: LOG_PAGE_LABEL, action: "点击「登录」", status: "info", detail: name });
    setRunning(true);
    try {
      const res = await invoke<MixcCliResult>("run_mixc", {
        params: {
          action: "login",
          account: loginId,
          password: item.loginMode === "password" ? item.password : "",
          code: item.loginMode === "sms" ? item.code.trim() : "",
        },
      });
      if (res.status === "device_limited") {
        setAccounts((prev) =>
          prev.map((account) =>
            account.id === item.id
              ? { ...account, loginMode: "sms", deviceLimited: true, phone: account.phone.trim() || loginId }
              : account
          )
        );
        setResult({ title: "需要验证码登录", message: `「${name}」遇到设备限制，已切换为手机验证码。` });
        return;
      }
      if (res.status === "logged_in") {
        setAccounts((prev) =>
          prev.map((account) =>
            account.id === item.id
              ? {
                  ...mergeResult(account, res),
                  account: account.loginMode === "password" ? loginId : account.account,
                  phone: account.loginMode === "sms" ? loginId : account.phone || loginId,
                }
              : account
          )
        );
        logOperation({ page: LOG_PAGE, pageLabel: LOG_PAGE_LABEL, action: "登录", status: "success", detail: name });
        return;
      }
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "登录",
        status: "error",
        detail: res.message || "登录失败",
      });
      setResult({ title: "登录失败", message: `「${name}」${res.message || "登录失败"}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ title: "登录失败", message: `「${name}」${message}` });
    } finally {
      setRunning(false);
    }
  };

  const logoutAccount = async (item: CheckinAccount) => {
    if (running) return;
    const account = sessionAccount(item);
    setAccounts((prev) =>
      prev.map((current) => (current.id === item.id ? { ...current, loggedIn: false, password: "", code: "" } : current))
    );
    if (!account || !configReady) return;
    try {
      await invoke<MixcCliResult>("run_mixc", {
        params: { action: "logout", account, password: "", code: "" },
      });
    } catch {
      setResult({ title: "退出未完成", message: "页面已切回登录表单，但本地登录文件可能还在。" });
    }
  };

  const signAccounts = async (targets: CheckinAccount[]) => {
    if (running) return;
    if (!ensureConfig()) return;
    const ready = targets.filter((item) => item.loggedIn && sessionAccount(item));
    if (ready.length === 0) {
      setResult({ title: "还不能签到", message: "请先登录账号。登录成功后表单会收起，再点执行签到。" });
      return;
    }
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「执行签到」",
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
        const name = accountLabel(item, accountsRef.current.findIndex((account) => account.id === item.id));
        setProgress(`正在签到 ${i + 1}/${ready.length}：${name}`);
        try {
          const res = await invoke<MixcCliResult>("run_mixc", {
            params: { action: "sign", account: sessionAccount(item), password: "", code: "" },
          });
          applyRemote(item.id, res);
          if (res.status === "success") {
            const gained = hasPoints(res.lastSignPoints) ? `，本次 ${res.lastSignPoints} 积分` : "";
            const balance = hasPoints(res.points) ? `，余额 ${res.points}` : "";
            lines.push(`「${name}」${res.message || "签到成功"}${gained}${balance}`);
          } else if (res.status === "logged_out") {
            hasProblem = true;
            lines.push(`「${name}」登录已失效，请重新登录`);
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
      action: "执行签到",
      status: hasProblem ? "error" : "success",
      detail: lines.join("；"),
    });
    setResult({ title: hasProblem ? "签到结束" : "签到完成", message: lines.join("\n") });
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

  const loggedCount = accounts.filter((item) => item.loggedIn).length;
  const signedCount = accounts.filter((item) => item.loggedIn && item.signedToday).length;

  return (
    <div className={cn(styles.checkin_page, "h-full w-full overflow-auto pb-8 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden")}>
      <div className="mx-auto w-full max-w-7xl space-y-4 px-5 pt-5">
        <div className={glassCard}>
          <GlassShine />
          <div className="relative flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="mr-auto flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 shadow-[0_0_12px_rgba(139,92,246,0.25)]">
                <CalendarCheck size={15} className="text-white" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-gray-800 dark:text-white/90">积分签到</div>
                <div className="truncate text-[10.5px] text-gray-400 dark:text-white/40">已登录的账号直接签到，未登录才填写账号</div>
              </div>
              <div className="ml-1 hidden items-center gap-2 text-[11px] text-gray-500 dark:text-white/50 sm:flex">
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>已登录 <span className="font-semibold text-violet-500">{loggedCount}</span></span>
                <span className="text-gray-300 dark:text-white/20">·</span>
                <span>今日已签 <span className="font-semibold text-emerald-500">{signedCount}</span></span>
              </div>
            </div>
            <button type="button" className={ghostButton} onClick={() => setConfigOpen(true)}>
              <FileUp size={12} /> 配置信息
            </button>
            <button type="button" className={ghostButton} disabled={running || accounts.length >= MAX_ACCOUNTS} onClick={addAccount}>
              <Plus size={12} /> 添加账号
            </button>
            <OperationLogButton page={LOG_PAGE} pageLabel={LOG_PAGE_LABEL} className="h-7" />
            <button type="button" className={primaryButton} disabled={running || loggedCount === 0} onClick={() => signAccounts(accounts)}>
              <CalendarCheck size={12} /> {running ? "签到中..." : "全部签到"}
            </button>
          </div>
          {progress && (
            <div className="relative border-t border-black/[0.06] px-3 py-2 text-[11px] text-violet-600 dark:border-white/[0.08] dark:text-violet-300">
              {progress}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 items-start gap-4">
          <AnimatePresence initial={false}>
            {accounts.map((item, index) => (
              <AccountCard
                key={item.id}
                index={index}
                total={accounts.length}
                account={item}
                errors={errors[item.id]}
                busy={running}
                confirming={syncing && !item.loggedIn && Boolean(sessionAccount(item))}
                onChange={(patch) => updateAccount(item.id, patch)}
                onMode={(mode) => changeMode(item.id, mode)}
                onRemove={() => removeAccount(item.id)}
                onRequestCode={() => requestSmsCode(item)}
                onLogin={() => loginAccount(item)}
                onLogout={() => logoutAccount(item)}
                onSign={() => signAccounts([item])}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <GlassModal
        open={result !== null}
        title={result?.title || ""}
        description={result?.message}
        onClose={() => setResult(null)}
        confirmText="知道了"
        onConfirm={() => setResult(null)}
      />

      <GlassModal
        open={configOpen}
        title="配置信息"
        description="导入 mixc_config.txt，或直接把配置内容贴在下面保存。账号和密码在页面上填写，不写进这个文件。"
        onClose={() => setConfigOpen(false)}
        wide
      >
        <textarea
          value={configText}
          spellCheck={false}
          placeholder={"AES_KEY=\nAES_IV=\nAPP_APPID=\nAPP_SIGN_KEY=\nAPP_SIGN_SALT=\nH5_APPID=\nH5_SIGN_KEY=\nDEVICE_ID="}
          className="h-52 w-full resize-none rounded-xl border border-black/10 bg-white/80 px-3 py-2 font-mono text-xs text-gray-800 outline-none focus:border-violet-400 dark:border-white/15 dark:bg-white/5 dark:text-white/90"
          onChange={(event) => setConfigText(event.target.value)}
        />
        {missingConfigFields(configText).length > 0 && (
          <p className="mt-2 text-xs text-red-500">还缺：{missingConfigFields(configText).join("、")}</p>
        )}
        {configPath && (
          <p className="mt-1 truncate text-[11px] text-gray-500 dark:text-white/50" title={configPath}>
            {configReady ? "已保存" : "未保存完整配置"}：{configPath}
          </p>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className={ghostButton}
            onClick={() =>
              importConfigFile().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                setResult({ title: "导入失败", message });
              })
            }
          >
            导入文件
          </button>
          <button
            type="button"
            className={primaryButton}
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
          </button>
        </div>
      </GlassModal>
    </div>
  );
}

function AccountCard({
  index,
  total,
  account,
  errors,
  busy,
  confirming,
  onChange,
  onMode,
  onRemove,
  onRequestCode,
  onLogin,
  onLogout,
  onSign,
}: {
  index: number;
  total: number;
  account: CheckinAccount;
  errors?: FieldErrors;
  busy?: boolean;
  confirming?: boolean;
  onChange: (patch: Partial<CheckinAccount>) => void;
  onMode: (mode: LoginMode) => void;
  onRemove: () => void;
  onRequestCode: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onSign: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const passwordMode = account.loginMode === "password";
  const accent = ACCENTS[index % ACCENTS.length];
  const name = accountLabel(account, index);

  return (
    <motion.section
      layout
      id={`checkin-account-${account.id}`}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8 }}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className={cn(glassCard, "group flex flex-col", account.deviceLimited && !account.loggedIn ? "ring-1 ring-amber-400/50" : "")}
    >
      <GlassShine />
      <div className={cn("relative z-[1] h-[3px] w-full bg-gradient-to-r", accent)} />
      <div className="relative z-[1] flex items-start gap-2 p-3.5 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-gray-800 dark:text-white/90">{name}</span>
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                account.loggedIn
                  ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                  : "border-black/10 bg-black/[0.04] text-gray-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-white/50"
              )}
            >
              {account.loggedIn ? "已登录" : "未登录"}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 dark:text-white/45">账号 {index + 1}</div>
        </div>
        {account.loggedIn && (
          <button
            type="button"
            disabled={busy}
            onClick={onLogout}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] text-gray-500 hover:bg-violet-500/15 hover:text-violet-500 disabled:opacity-40 dark:bg-white/[0.06] dark:text-white/60"
            title="退出登录并重新填写"
          >
            <LogOut size={13} />
          </button>
        )}
        {total > 1 && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            aria-label={`删除账号 ${index + 1}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] text-gray-500 hover:bg-red-500/15 hover:text-red-500 disabled:opacity-40 dark:bg-white/[0.06] dark:text-white/60"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {confirming ? (
        <div className="relative z-[1] px-3.5 pb-4 text-[11px] text-violet-600 dark:text-violet-300">正在确认登录状态...</div>
      ) : account.loggedIn ? (
        <div className="relative z-[1] flex flex-1 flex-col px-3.5 pb-3.5">
          <div className="grid grid-cols-1 gap-2">
            <Stat label="积分余额" value={showValue(account.points)} emphasize />
            <Stat label="上次签到积分" value={showValue(account.lastSignPoints)} />
            <Stat
              label="今天是否签到"
              value={account.signedToday === true ? "已签到" : account.signedToday === false ? "未签到" : "--"}
              tone={account.signedToday === true ? "ok" : account.signedToday === false ? "wait" : "muted"}
            />
          </div>
          <button type="button" className={cn(primaryButton, "mt-3 w-full")} disabled={busy} onClick={onSign}>
            <CalendarCheck size={13} /> {busy ? "签到中..." : "执行签到"}
          </button>
        </div>
      ) : (
        <form
          className="relative z-[1] flex flex-1 flex-col px-3.5 pb-3.5"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onLogin();
          }}
          noValidate
        >
          <div className="mb-3 inline-flex w-full rounded-lg border border-black/10 bg-white/70 p-0.5 dark:border-white/10 dark:bg-white/[0.04]">
            <ModeButton active={passwordMode} icon={<KeyRound size={13} />} label="账号密码" onClick={() => onMode("password")} />
            <ModeButton active={!passwordMode} icon={<Smartphone size={13} />} label="手机验证码" onClick={() => onMode("sms")} />
          </div>
          {account.deviceLimited && (
            <div className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-200">
              登录遇到设备限制，已切换为手机验证码。获取验证码并登录后即可签到。
            </div>
          )}
          {passwordMode ? (
            <div className="grid gap-2.5">
              <Field label="账号" error={errors?.account}>
                <input
                  value={account.account}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="请输入手机号"
                  className={fieldClass(errors?.account)}
                  onChange={(event) => onChange({ account: event.target.value })}
                />
              </Field>
              <Field label="密码" error={errors?.password}>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={account.password}
                    autoComplete="new-password"
                    placeholder="请输入密码"
                    className={cn(fieldClass(errors?.password), "pr-8")}
                    onChange={(event) => onChange({ password: event.target.value })}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:hover:text-white/80"
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
            </div>
          ) : (
            <div className="grid gap-2.5">
              <Field label="手机号" error={errors?.phone}>
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  value={account.phone}
                  placeholder="请输入手机号"
                  className={fieldClass(errors?.phone)}
                  onChange={(event) => onChange({ phone: event.target.value.replace(/\D/g, "").slice(0, 11) })}
                />
              </Field>
              <Field label="验证码" error={errors?.code}>
                <div className="flex gap-1.5">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={account.code}
                    placeholder="请输入验证码"
                    className={cn(fieldClass(errors?.code), "min-w-0 flex-1")}
                    onChange={(event) => onChange({ code: event.target.value.replace(/\D/g, "").slice(0, 6) })}
                  />
                  <button
                    type="button"
                    className={cn(ghostButton, "h-8 shrink-0")}
                    disabled={busy || account.codeCooldown > 0}
                    onClick={onRequestCode}
                  >
                    {account.codeCooldown > 0 ? `${account.codeCooldown}s` : "获取验证码"}
                  </button>
                </div>
              </Field>
            </div>
          )}
          <button type="submit" className={cn(primaryButton, "mt-3 w-full")} disabled={busy}>
            {busy ? "登录中..." : "登录"}
          </button>
        </form>
      )}
    </motion.section>
  );
}

function Stat({
  label,
  value,
  emphasize,
  tone = "muted",
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  tone?: "ok" | "wait" | "muted";
}) {
  return (
    <div className="rounded-xl border border-black/[0.06] bg-black/[0.03] px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="text-[10px] text-gray-500 dark:text-white/45">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm font-semibold",
          emphasize && "text-amber-600 dark:text-amber-300",
          !emphasize && tone === "ok" && "text-emerald-600 dark:text-emerald-300",
          !emphasize && tone === "wait" && "text-amber-600 dark:text-amber-300",
          !emphasize && tone === "muted" && "text-gray-800 dark:text-white/90"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-gray-500 dark:text-white/50">{label}</span>
      {children}
      {error && <span className="text-[11px] text-red-500">{error}</span>}
    </label>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors",
        active
          ? "bg-violet-500 text-white shadow-[0_0_10px_rgba(139,92,246,0.35)]"
          : "text-gray-500 hover:text-gray-800 dark:text-white/50 dark:hover:text-white/80"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function GlassShine() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background: "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%)",
          mixBlendMode: "overlay",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 35%, rgba(0,0,0,0.04) 100%)",
        }}
      />
    </>
  );
}

function GlassModal({
  open,
  title,
  description,
  onClose,
  children,
  confirmText,
  onConfirm,
  wide,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  confirmText?: string;
  onConfirm?: () => void;
  wide?: boolean;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className={cn(
          "relative w-full rounded-2xl border border-black/[0.08] bg-white/95 p-4 shadow-2xl backdrop-blur-2xl dark:border-white/[0.10] dark:bg-[#0b0b14]/95",
          wide ? "max-w-lg" : "max-w-sm"
        )}
      >
        <div className="text-sm font-semibold text-gray-800 dark:text-white/90">{title}</div>
        {description && (
          <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-gray-600 dark:text-white/60">{description}</div>
        )}
        {children}
        {confirmText && onConfirm && (
          <div className="mt-3 flex justify-end">
            <button type="button" className={primaryButton} onClick={onConfirm}>
              {confirmText}
            </button>
          </div>
        )}
      </motion.div>
    </div>,
    document.body
  );
}
