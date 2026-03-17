import { config } from "./config.js";

export function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = decodeURIComponent(part.slice(0, separatorIndex));
      const value = decodeURIComponent(part.slice(separatorIndex + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function setSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(config.sessionCookieName, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: config.isProduction,
      maxAge: 60 * 60 * 12,
    }),
  );
}

export function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(config.sessionCookieName, "", {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: config.isProduction,
      maxAge: 0,
    }),
  );
}

export function buildError(message, statusCode = 500, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}
