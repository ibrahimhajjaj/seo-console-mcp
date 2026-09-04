export function formatToolError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  const response = isRecord(record.response) ? record.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const apiError = data && isRecord(data.error) ? data.error : undefined;
  const status = numberValue(response?.status) ?? numberValue(record.code);
  const message = stringValue(apiError?.message) ?? stringValue(record.message) ?? "Unknown error";
  if (!response && !apiError && !status) return message;
  const errors = apiError && Array.isArray(apiError.errors) ? apiError.errors : [];
  const reasons = errors.flatMap((entry) => (isRecord(entry) && stringValue(entry.reason) ? [stringValue(entry.reason) as string] : []));
  const statusText = status ? `Google API ${status}` : "Google API error";
  const reasonText = reasons.length ? ` (${[...new Set(reasons)].join(", ")})` : "";
  if (status === 403) {
    return `${statusText}${reasonText}: ${message}. Confirm the service account email is an Owner of this Search Console property under Settings -> Users and permissions.`;
  }
  return `${statusText}${reasonText}: ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
