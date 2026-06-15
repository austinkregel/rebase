import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/transport/contract'
import { defaultDashboardUrl } from '@/transport/socket'

export interface ControlPlaneInfo {
  name: string
  url: string
  certSha256?: string
}

export interface AuthInfo {
  authenticated: boolean
}

export interface CredentialInput {
  token?: string
  clientId?: string
  clientSecret?: string
}

/**
 * Platform-specific session operations. In the desktop app these are Tauri
 * commands backed by the Rust core (keychain, deep-link sign-in, token minting);
 * in the browser they map to the control plane's OIDC session endpoints. The
 * session store talks only to this.
 */
export interface Platform {
  /** True when the app stores its own credentials (desktop). */
  readonly supportsCredentials: boolean
  authStatus(): Promise<AuthInfo>
  listControlPlanes(): Promise<ControlPlaneInfo[]>
  /** CP-brokered browser sign-in: opens the system browser; the token arrives async. */
  login(controlPlane?: string): Promise<void>
  /** Non-browser fallback: store a token or client creds directly. */
  setCredentials(input: CredentialInput): Promise<void>
  logout(): Promise<void>
  /** Fires when auth changes out-of-band (the rebase:// deep-link callback). */
  onAuthChanged(handler: () => void): () => void
  /** Fires when an out-of-band sign-in attempt fails (bad deep-link token). */
  onAuthError(handler: (message: string) => void): () => void
  /** Read the control plane's exec allowlist (commands agents may run). */
  getExecAllowlist(controlPlane?: string): Promise<string[]>
  /** Replace the control plane's exec allowlist (it re-pushes to all agents). */
  setExecAllowlist(commands: string[], controlPlane?: string): Promise<void>
}

class TauriPlatform implements Platform {
  readonly supportsCredentials = true

  async authStatus(): Promise<AuthInfo> {
    return await invoke<AuthInfo>('auth_status')
  }

  async listControlPlanes(): Promise<ControlPlaneInfo[]> {
    const raw = await invoke<{ name: string; url: string; cert_sha256?: string }[]>(
      'list_control_planes',
    )
    return raw.map((c) => ({ name: c.name, url: c.url, certSha256: c.cert_sha256 }))
  }

  async login(controlPlane?: string): Promise<void> {
    await invoke('login', { controlPlane: controlPlane ?? null })
  }

  async setCredentials(input: CredentialInput): Promise<void> {
    await invoke('set_credentials', {
      token: input.token ?? null,
      clientId: input.clientId ?? null,
      clientSecret: input.clientSecret ?? null,
    })
  }

  async logout(): Promise<void> {
    await invoke('logout')
  }

  onAuthChanged(handler: () => void): () => void {
    let unlisten: (() => void) | undefined
    void listen('auth://updated', () => handler()).then((u) => {
      unlisten = u
    })
    return () => unlisten?.()
  }

  onAuthError(handler: (message: string) => void): () => void {
    let unlisten: (() => void) | undefined
    void listen<string>('auth://error', (e) => handler(e.payload)).then((u) => {
      unlisten = u
    })
    return () => unlisten?.()
  }

  async getExecAllowlist(controlPlane?: string): Promise<string[]> {
    return await invoke<string[]>('exec_allowlist_get', { controlPlane: controlPlane ?? null })
  }

  async setExecAllowlist(commands: string[], controlPlane?: string): Promise<void> {
    await invoke('exec_allowlist_set', { commands, controlPlane: controlPlane ?? null })
  }
}

class BrowserPlatform implements Platform {
  readonly supportsCredentials = false

  async authStatus(): Promise<AuthInfo> {
    try {
      const res = await fetch('/api/auth/status', {
        credentials: 'include',
        signal: AbortSignal.timeout(8000),
      })
      const json = (await res.json()) as { authenticated?: boolean }
      return { authenticated: !!json.authenticated }
    } catch {
      return { authenticated: false }
    }
  }

  async listControlPlanes(): Promise<ControlPlaneInfo[]> {
    // The browser build is served from the control plane it talks to.
    return [{ name: 'control plane', url: defaultDashboardUrl() }]
  }

  async login(): Promise<void> {
    location.href = '/auth/login'
  }

  async setCredentials(): Promise<void> {
    location.href = '/auth/login'
  }

  async logout(): Promise<void> {
    location.href = '/auth/logout'
  }

  onAuthChanged(): () => void {
    // Browser sign-in round-trips through navigation, so auth is re-checked on load.
    return () => {}
  }

  onAuthError(): () => void {
    // No out-of-band sign-in in the browser; errors surface on the login page.
    return () => {}
  }

  // The browser build is served from the control plane, so its API is same-origin
  // and authenticated by the session cookie.
  async getExecAllowlist(): Promise<string[]> {
    const res = await fetch('/api/server/exec-allowlist', { credentials: 'include' })
    const json = (await res.json()) as { commands?: string[] }
    return json.commands ?? []
  }

  async setExecAllowlist(commands: string[]): Promise<void> {
    await fetch('/api/server/exec-allowlist', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands }),
    })
  }
}

export const platform: Platform = isTauri() ? new TauriPlatform() : new BrowserPlatform()
