import { createAlova } from "alova";
import adapterFetch from "alova/fetch";

export const baseURL = "http://111.231.18.118:5000";
// export const baseURL = "http://192.168.110.225:5000";

export const alovaInstance = createAlova({
  baseURL,
  requestAdapter: adapterFetch(),
  timeout: 120000,
});
