const DOMAIN_PROPERTY_PREFIX = "sc-domain:";

export function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith(DOMAIN_PROPERTY_PREFIX)) {
    const domain = trimmed.slice(DOMAIN_PROPERTY_PREFIX.length).toLowerCase();
    if (!domain || domain.includes("://") || domain.includes("/") || !isValidHostname(domain)) {
      throw new Error("siteUrl must be an http(s) URL-prefix property or sc-domain:example.com");
    }
    return `${DOMAIN_PROPERTY_PREFIX}${domain}`;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("siteUrl must be an http(s) URL-prefix property or sc-domain:example.com");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("siteUrl must use http or https");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function isValidHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}
