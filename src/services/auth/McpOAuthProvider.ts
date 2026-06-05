import crypto from 'crypto';
import { Response } from 'express';
import { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { config } from '../../config/trading';

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

// ── In-memory stores ──────────────────────────────────────────────────────────

const clientsMap  = new Map<string, OAuthClientInformationFull>();
const authCodes   = new Map<string, CodeRecord>();
const accessTokens  = new Map<string, TokenRecord>();
const refreshTokens = new Map<string, TokenRecord>();

class ClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string) {
    return clientsMap.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: crypto.randomBytes(16).toString('hex'),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    clientsMap.set(full.client_id, full);
    return full;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class McpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore = new ClientsStore();

  // Called by mcpAuthRouter when GET /authorize is hit
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const needsPassword = Boolean(config.server.apiKey);
    res.send(buildLoginPage({
      clientId:      client.client_id,
      clientName:    (client as any).client_name ?? client.client_id,
      redirectUri:   params.redirectUri,
      codeChallenge: params.codeChallenge,
      state:         params.state ?? '',
      scopes:        (params.scopes ?? []).join(' '),
      needsPassword,
    }));
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    const record = authCodes.get(code);
    if (!record || Date.now() > record.expiresAt) throw new Error('Invalid or expired authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = authCodes.get(code);
    if (!record || Date.now() > record.expiresAt) throw new Error('Invalid or expired authorization code');
    if (record.clientId !== client.client_id) throw new Error('Client mismatch');
    authCodes.delete(code);

    const accessToken  = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const expiresIn    = 3600;

    accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes:   record.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes:   record.scopes,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    });

    return {
      access_token:  accessToken,
      token_type:    'bearer',
      expires_in:    expiresIn,
      refresh_token: refreshToken,
      scope:         record.scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = refreshTokens.get(refreshToken);
    if (!record || Date.now() > record.expiresAt) throw new Error('Invalid or expired refresh token');
    if (record.clientId !== client.client_id) throw new Error('Client mismatch');

    const newToken  = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600;
    accessTokens.set(newToken, {
      clientId: client.client_id,
      scopes:   scopes ?? record.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return {
      access_token:  newToken,
      token_type:    'bearer',
      expires_in:    expiresIn,
      refresh_token: refreshToken,
      scope: (scopes ?? record.scopes).join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = accessTokens.get(token);
    if (!record || Date.now() > record.expiresAt) throw new Error('Invalid or expired access token');
    return {
      token,
      clientId:  record.clientId,
      scopes:    record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
    };
  }
}

// ── Auth code creation (called by /authorize/submit route) ────────────────────

export function createAuthCode(
  clientId: string,
  codeChallenge: string,
  redirectUri: string,
  scopes: string[],
): string {
  const code = crypto.randomBytes(16).toString('hex');
  authCodes.set(code, {
    clientId,
    codeChallenge,
    redirectUri,
    scopes,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
  });
  return code;
}

// ── Login page HTML ───────────────────────────────────────────────────────────

function buildLoginPage(p: {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string;
  needsPassword: boolean;
}) {
  const passField = p.needsPassword ? `
    <div class="field">
      <label>Mật khẩu truy cập</label>
      <input type="password" name="password" placeholder="Nhập mật khẩu" autofocus required>
    </div>` : `<input type="hidden" name="password" value="">`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Trading Signal — Đăng nhập</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2rem; width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 1.5rem; }
    .logo h1 { font-size: 1.25rem; font-weight: 700; color: #f59e0b; }
    .logo p  { font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem; }
    .client  { background: #0f172a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.85rem; color: #94a3b8; }
    .client strong { color: #e2e8f0; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.4rem; }
    .field input { width: 100%; padding: 0.6rem 0.75rem; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 0.9rem; outline: none; }
    .field input:focus { border-color: #f59e0b; }
    .btn { width: 100%; padding: 0.7rem; background: #f59e0b; color: #0f172a; border: none; border-radius: 6px; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #d97706; }
    .err { display: none; background: #450a0a; border: 1px solid #7f1d1d; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.8rem; color: #fca5a5; margin-bottom: 1rem; }
    .err.show { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h1>📊 AI Trading Signal</h1>
      <p>Xác thực để kết nối MCP</p>
    </div>
    <div class="client">
      Ứng dụng <strong>${escHtml(p.clientName)}</strong> đang yêu cầu truy cập
    </div>
    <div class="err" id="err">Mật khẩu không đúng</div>
    <form method="POST" action="/authorize/submit">
      <input type="hidden" name="client_id"      value="${escHtml(p.clientId)}">
      <input type="hidden" name="redirect_uri"   value="${escHtml(p.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escHtml(p.codeChallenge)}">
      <input type="hidden" name="state"          value="${escHtml(p.state)}">
      <input type="hidden" name="scopes"         value="${escHtml(p.scopes)}">
      ${passField}
      <button type="submit" class="btn">Cho phép truy cập</button>
    </form>
  </div>
  <script>
    const u = new URLSearchParams(location.search);
    if (u.get('error')) document.getElementById('err').classList.add('show');
  </script>
</body>
</html>`;
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
