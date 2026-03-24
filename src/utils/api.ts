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
  code?: number;
  status?: number;
  message?: string;
  imageUrl?: string;
  data?: {
    type: "image" | "log";
    imageUrl?: string;
    logs?: string[];
    formatted_text?: string;
    count?: number;
  };
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

export const healthCheck = () => {
  return alovaInstance.Get<HealthResponse>("/health");
};
