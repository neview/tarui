import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ReleaseFormData {
  username: string;
  password: string;
  secretKey: string;
  version: string;
  name: string;
  sendMessage: string;
  appid: string;
  desc: string;
}

interface ReleaseFormProps {
  onSubmit?: (data: ReleaseFormData) => void;
  loading?: boolean;
}

interface FormErrors {
  username?: string;
  password?: string;
  secretKey?: string;
  version?: string;
  name?: string;
  appid?: string;
  desc?: string;
}

export function ReleaseForm({ onSubmit, loading }: ReleaseFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [sendMessage, setSendMessage] = useState("1");
  const [errors, setErrors] = useState<FormErrors>({});

  const validate = (): boolean => {
    const newErrors: FormErrors = {};
    const form = document.getElementById("release-form") as HTMLFormElement;
    const formData = new FormData(form);

    const username = formData.get("username") as string;
    const password = formData.get("password") as string;
    const secretKey = formData.get("secretKey") as string;
    const version = formData.get("version") as string;
    const name = formData.get("name") as string;
    const appid = formData.get("appid") as string;
    const desc = formData.get("desc") as string;

    if (!username.trim()) {
      newErrors.username = "用户名不能为空";
    }
    if (!password.trim()) {
      newErrors.password = "密码不能为空";
    }
    if (!secretKey.trim()) {
      newErrors.secretKey = "密钥不能为空";
    }
    if (!version.trim()) {
      newErrors.version = "版本号不能为空";
    } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
      newErrors.version = "版本号格式不正确，例如：1.0.1";
    }
    if (!name.trim()) {
      newErrors.name = "名称不能为空";
    }
    if (!appid.trim()) {
      newErrors.appid = "应用ID不能为空";
    } else {
      try {
        const parsed = JSON.parse(appid);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          newErrors.appid = "请输入有效的JSON数组格式";
        }
      } catch {
        newErrors.appid = "请输入有效的JSON数组格式，例如：[\"wx123456789\"]";
      }
    }
    if (!desc.trim()) {
      newErrors.desc = "版本描述不能为空";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const formData = new FormData(e.target as HTMLFormElement);
    if (onSubmit) {
      onSubmit({
        username: formData.get("username") as string,
        password: formData.get("password") as string,
        secretKey: formData.get("secretKey") as string,
        version: formData.get("version") as string,
        name: formData.get("name") as string,
        sendMessage,
        appid: formData.get("appid") as string,
        desc: formData.get("desc") as string,
      });
    }
  };

  return (
    <form id="release-form" onSubmit={handleSubmit} noValidate>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="username">用户名 *</Label>
          <Input
            id="username"
            name="username"
            placeholder="请输入用户名"
            className={errors.username ? "border-red-500" : ""}
          />
          {errors.username && <p className="text-sm text-red-500">{errors.username}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password">密码 *</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="请输入密码"
              className={`pr-10 ${errors.password ? "border-red-500" : ""}`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
            >
              {showPassword ? "👁" : "👁‍🗨"}
            </button>
          </div>
          {errors.password && <p className="text-sm text-red-500">{errors.password}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="secretKey">密钥 *</Label>
          <div className="relative">
            <Input
              id="secretKey"
              name="secretKey"
              type={showSecretKey ? "text" : "password"}
              placeholder="请输入密钥"
              className={`pr-10 ${errors.secretKey ? "border-red-500" : ""}`}
            />
            <button
              type="button"
              onClick={() => setShowSecretKey(!showSecretKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
            >
              {showSecretKey ? "👁" : "👁‍🗨"}
            </button>
          </div>
          {errors.secretKey && <p className="text-sm text-red-500">{errors.secretKey}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="version">版本号 *</Label>
          <Input
            id="version"
            name="version"
            placeholder="例如: 1.0.1"
            className={errors.version ? "border-red-500" : ""}
          />
          {errors.version && <p className="text-sm text-red-500">{errors.version}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="name">名称 *</Label>
          <Input
            id="name"
            name="name"
            placeholder="用于@消息推送"
            className={errors.name ? "border-red-500" : ""}
          />
          {errors.name && <p className="text-sm text-red-500">{errors.name}</p>}
        </div>

        <div className="grid gap-2">
          <Label>发送消息</Label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="sendMessage"
                value="1"
                checked={sendMessage === "1"}
                onChange={(e) => setSendMessage(e.target.value)}
              />
              <span>发送</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="sendMessage"
                value="0"
                checked={sendMessage === "0"}
                onChange={(e) => setSendMessage(e.target.value)}
              />
              <span>不发送</span>
            </label>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="appid">应用ID *</Label>
          <Input
            id="appid"
            name="appid"
            placeholder='JSON格式，如 ["wx123456789"]'
            className={errors.appid ? "border-red-500" : ""}
          />
          {errors.appid && <p className="text-sm text-red-500">{errors.appid}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="desc">版本描述 *</Label>
          <textarea
            id="desc"
            name="desc"
            rows={4}
            className={`flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${errors.desc ? "border-red-500" : ""}`}
            placeholder="请输入版本描述..."
          />
          {errors.desc && <p className="text-sm text-red-500">{errors.desc}</p>}
        </div>

        <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "发布中..." : "发布版本"}
          </Button>
      </div>
    </form>
  );
}
