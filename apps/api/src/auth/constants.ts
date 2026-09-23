export const SESSION_COOKIE_NAME = "fc_sid";
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000; // 12h cap, ported from the old app's absolute_ttl_min=720
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min, ported from the old app's known lockout behaviour
