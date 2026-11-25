// JSON requests to the workbench API.

export async function api(path, method = "GET", data) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    options.headers["X-Requested-With"] = "GroupCompute";
    options.headers["Content-Type"] = "application/json";
    if (data !== undefined) options.body = JSON.stringify(data);
  }
  const r = await fetch(path, options);
  let body;
  try {
    body = await r.json();
  } catch {
    body = { error: "服务器未返回有效响应，请重试" };
  }
  if (!r.ok) {
    const e = new Error(body.error || `请求失败 (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return body;
}
