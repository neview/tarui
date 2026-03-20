import { alovaInstance } from "./alova";

export interface ReleaseVersionParams {
  username: string;
  password: string;
  secretKey: string;
  version: string;
  name: string;
  sendMessage?: string;
  appid: string;
  desc: string;
}

/** 接口返回格式：{ code, message, log } */
export interface ReleaseVersionResponse {
  code: number;
  message: string;
  log?: string[];
}

export interface WxRibaoParams {
  startDate: string;
  endDate: string;
  outputFormat?: string;
  indentInTheLine?: string;
  formUrl?: string;
  cookiesFile?: string;
}

export interface WxRibaoResponse {
  status: number;
  message: string;
  data?: {
    formatted_text: string;
    count: number;
  };
}

export interface HealthResponse {
  status: string;
}

export async function releaseVersion(
  params: ReleaseVersionParams
): Promise<ReleaseVersionResponse> {
  const res = await alovaInstance.Post("/api/release-version", params);
  const raw = res as Response;
  const text = await raw.text();
  if (!text?.trim()) {
    return { code: 0, message: "响应为空" };
  }
  try {
    return JSON.parse(text) as ReleaseVersionResponse;
  } catch {
    return { code: 0, message: "响应格式错误" };
  }
}

export const getWxRibao = (params: WxRibaoParams) => {
  return alovaInstance.Post<WxRibaoResponse>("/api/wx-ribao", params);
};

export const healthCheck = () => {
  return alovaInstance.Get<HealthResponse>("/health");
};
