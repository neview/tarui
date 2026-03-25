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
  sessionId: string;
}

export interface WxRibaoLogEntry {
  time: string;
  msg: string;
}

export interface WxRibaoStatusResponse {
  status: "pending" | "waiting" | "need_login" | "success" | "expired" | "error" | "cancelled";
  message?: string;
  logs?: WxRibaoLogEntry[];
  imageUrl?: string;
  data?: string | string[];
}

export interface HealthResponse {
  status: string;
}

export interface CaptureQrResponse {
  success: boolean;
  qr_code?: string;
  error?: string;
}

export async function releaseVersion(
  params: ReleaseVersionParams
): Promise<ReleaseVersionResponse> {
  return alovaInstance.Post<ReleaseVersionResponse>("/api/release-version", params);
}

export const captureQr = () => {
  return alovaInstance.Post<CaptureQrResponse>("/api/capture-qr");
};

export const getWxRibao = (params: WxRibaoParams) => {
  return alovaInstance.Post<WxRibaoResponse>("/api/wx-ribao", params);
};

export const getWxRibaoStatus = (sessionId: string) => {
  return alovaInstance.Get<WxRibaoStatusResponse>("/api/wx-ribao/status", {
    params: { sid: sessionId },
    cacheFor: 0,
  });
};

export const cancelWxRibao = (sessionId: string) => {
  return alovaInstance.Post("/api/wx-ribao/cancel", { sid: sessionId });
};

export const healthCheck = () => {
  return alovaInstance.Get<HealthResponse>("/health");
};
