const OWN_VARIABLE = /^(SEO_MCP_|GOOGLE_ADS_|GOOGLE_APPLICATION_CREDENTIALS$)/;
const UNFILLED_PLACEHOLDER = /^\$\{[^}]*\}$/;

// A client that renders a settings form, such as an MCPB host, passes every field
// it knows about, so an optional field left blank arrives as "" or, in some hosts,
// as the untouched "${user_config.x}" template. Both have to mean "not set": the
// readers fall back with ??, so a blank SEO_MCP_CREDENTIALS would otherwise hide
// GOOGLE_APPLICATION_CREDENTIALS and a blank SEO_MCP_CRUX_KEY would hide the
// PageSpeed key it is meant to fall back to. Only this server's own variables are
// touched.
export function dropUnsetVariables(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!OWN_VARIABLE.test(name) || value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "" || UNFILLED_PLACEHOLDER.test(trimmed)) delete env[name];
  }
}
