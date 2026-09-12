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
  // The other URL parameter in this package already refuses these. A property is
  // echoed back in the result, written into snapshot files on disk and used to
  // name rows, so a password pasted into one would be copied wherever those go.
  // Refusing is also honest: Search Console has no such property, so a URL
  // carrying credentials was never going to match anything.
  if (url.username || url.password) {
    throw new Error("siteUrl must not contain embedded credentials. Search Console has no property of that form, and the value is echoed into results and snapshot files.");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function isValidHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
