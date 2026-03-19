import { config } from "./config.js";
import { buildError } from "./http.js";

export async function fetchAccessibleResources(accessToken) {
  const token = String(accessToken ?? "").trim();

  if (!token) {
    throw buildError("Missing access token.", 401);
  }

  const response = await fetch(config.atlassian.accessibleResourcesUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await response.json().catch(() => []);

  if (!response.ok) {
    throw buildError(
      "Failed to fetch accessible Atlassian resources.",
      response.status,
      payload,
    );
  }

  return Array.isArray(payload) ? payload : [];
}
