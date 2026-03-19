import { config } from "./config.js";
import { buildError } from "./http.js";

function logAtlassianApiDebug(event, details = {}) {
  if (!config.atlassian.debugAuth) {
    return;
  }

  console.log(`[atlassian-api] ${event}`, details);
}
export async function fetchAccessibleResources(accessToken) {
  const tokenString = String(accessToken ?? "").trim();

  if (!tokenString) {
    throw buildError("Missing Atlassian access token for accessible resources.", 401);
  }

  logAtlassianApiDebug("accessible_resources_request", {
    url: config.atlassian.accessibleResourcesUrl,
    hasAccessToken: true,
    authorizationScheme: "Bearer",
    accessTokenLength: tokenString.length,
  });

  const response = await fetch(config.atlassian.accessibleResourcesUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenString}`,
    },
  });

  const payload = await response.json().catch(() => []);

  if (!response.ok) {
    logAtlassianApiDebug("accessible_resources_failed", {
      status: response.status,
      payload,
    });

    throw buildError(
      "Failed to load Atlassian accessible resources.",
      response.status,
      payload,
    );
  }

  return Array.isArray(payload) ? payload : [];
}



