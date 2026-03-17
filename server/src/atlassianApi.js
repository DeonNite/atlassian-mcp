import { config } from "./config.js";
import { buildError } from "./http.js";

export async function fetchAccessibleResources(accessToken) {
  const response = await fetch(config.atlassian.accessibleResourcesUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => []);

  if (!response.ok) {
    throw buildError(
      "Failed to load Atlassian accessible resources.",
      response.status,
      payload,
    );
  }

  return Array.isArray(payload) ? payload : [];
}
