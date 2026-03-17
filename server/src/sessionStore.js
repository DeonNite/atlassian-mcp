import { randomUUID } from "node:crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

function buildEmptySession() {
  return {
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    oauth: null,
    atlassian: null,
    chat: {
      previousResponseId: null,
      activeCloudId: null,
    },
  };
}

function purgeExpiredSessions() {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

export function createSession() {
  purgeExpiredSessions();

  const sessionId = randomUUID();
  const session = buildEmptySession();
  sessions.set(sessionId, session);

  return { sessionId, session };
}

export function getSession(sessionId) {
  purgeExpiredSessions();

  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId) ?? null;

  if (session) {
    session.lastSeenAt = Date.now();
  }

  return session;
}

export function clearConversation(session) {
  session.chat = {
    previousResponseId: null,
    activeCloudId: null,
  };
}

export function clearAtlassianSession(session) {
  session.oauth = null;
  session.atlassian = null;
  clearConversation(session);
}
