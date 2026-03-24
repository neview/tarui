import { createAlova } from "alova";
import adapterFetch from "alova/fetch";

export const baseURL = "http://111.231.18.118:5000";
// export const baseURL = "http://192.168.110.225:5000";

export const alovaInstance = createAlova({
  baseURL,
  requestAdapter: adapterFetch(),
  timeout: 300_000,
  responded: {
    onSuccess: async (response) => {
      const raw = response as Response;
      const text = await raw.text();
      if (!text?.trim()) throw new Error("响应为空");
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("响应格式错误：" + text.slice(0, 200));
      }
    },
    onError: (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  },
});
