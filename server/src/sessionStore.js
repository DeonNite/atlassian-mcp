import { randomUUID } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function buildEmptySession() {
  return {
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    oauth: null,
    atlassian: null,
    lastOauthCallback: null,
    activeCloudId: null,
  };
}

function cleanupExpiredSessions() {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

export function createSession() {
  cleanupExpiredSessions();
  const sessionId = randomUUID();
  const session = buildEmptySession();
  sessions.set(sessionId, session);
  return { sessionId, session };
}

export function getSession(sessionId) {
  cleanupExpiredSessions();

  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId) ?? null;

  if (session) {
    session.lastSeenAt = Date.now();
  }

  return session;
}

export function clearAtlassianSession(session) {
  session.oauth = null;
  session.atlassian = null;
  session.lastOauthCallback = null;
  session.activeCloudId = null;
}
