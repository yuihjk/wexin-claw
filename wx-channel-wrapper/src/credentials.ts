import fs from "node:fs";
import path from "node:path";

import { DEFAULT_BASE_URL, CDN_BASE_URL, listIndexedWeixinAccountIds, loadWeixinAccount, registerWeixinAccountId, saveWeixinAccount } from "openclaw-weixin/src/auth/accounts.js";
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin } from "openclaw-weixin/src/auth/login-qr.js";
import { resolveStateDir } from "openclaw-weixin/src/storage/state-dir.js";

import type { WeixinCredentials } from "./types.js";

export function loadCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): WeixinCredentials | null {
  const accountId = env.WX_ACCOUNT_ID?.trim();
  const token = env.WX_TOKEN?.trim();
  if (!accountId || !token) return null;
  return {
    accountId,
    token,
    baseUrl: env.WX_BASE_URL?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: env.WX_CDN_BASE_URL?.trim() || CDN_BASE_URL,
  };
}

export function loadStoredCredentials(accountId: string): WeixinCredentials | null {
  const data = loadWeixinAccount(accountId);
  const token = data?.token?.trim();
  if (!token) return null;
  return {
    accountId,
    token,
    baseUrl: data?.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
  };
}

type StoredCredentialCandidate = WeixinCredentials & {
  savedAtMs: number;
};

function resolveAccountsDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "accounts");
}

function listAccountIdsFromFiles(): string[] {
  try {
    return fs.readdirSync(resolveAccountsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"))
      .filter((name) => !name.endsWith(".sync.json") && !name.endsWith(".context-tokens.json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

function savedAtMs(accountId: string): number {
  const data = loadWeixinAccount(accountId);
  const parsed = data?.savedAt ? Date.parse(data.savedAt) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;

  try {
    return fs.statSync(path.join(resolveAccountsDir(), `${accountId}.json`)).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadLatestStoredCredentials(): WeixinCredentials | null {
  const ids = [...new Set([...listIndexedWeixinAccountIds(), ...listAccountIdsFromFiles()])];
  const candidates: StoredCredentialCandidate[] = [];
  for (const id of ids) {
    const credentials = loadStoredCredentials(id);
    if (!credentials) continue;
    candidates.push({ ...credentials, savedAtMs: savedAtMs(id) });
  }
  candidates.sort((a, b) => b.savedAtMs - a.savedAtMs);
  return candidates[0] ?? null;
}

export async function loginWithQr(options: {
  accountId?: string;
  timeoutMs?: number;
  apiBaseUrl?: string;
  botType?: string;
  verbose?: boolean;
} = {}): Promise<WeixinCredentials> {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_BASE_URL;
  const started = await startWeixinLoginWithQr({
    accountId: options.accountId,
    apiBaseUrl,
    botType: options.botType,
    verbose: options.verbose,
  });

  if (!started.qrcodeUrl) {
    throw new Error(started.message || "Failed to start Weixin QR login");
  }

  await displayQRCode(started.qrcodeUrl);
  const result = await waitForWeixinLogin({
    sessionKey: started.sessionKey,
    apiBaseUrl,
    botType: options.botType,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });

  if (!result.connected || !result.accountId || !result.botToken) {
    throw new Error(result.message || "Weixin QR login was not completed");
  }

  const credentials: WeixinCredentials = {
    accountId: result.accountId,
    token: result.botToken,
    baseUrl: result.baseUrl || apiBaseUrl,
    cdnBaseUrl: CDN_BASE_URL,
  };

  saveWeixinAccount(credentials.accountId, {
    token: credentials.token,
    baseUrl: credentials.baseUrl,
    userId: result.userId,
  });
  registerWeixinAccountId(credentials.accountId);

  return credentials;
}
