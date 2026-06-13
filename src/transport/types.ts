// Wire types for the control-plane dashboard protocol.
// Field names mirror the Go structs' json tags exactly — see docs/PROTOCOL.md.

/** Every frame on /ws/dashboard, both directions. */
export interface Envelope {
  event: string
  data: Record<string, unknown>
}

/** One agent in `client_list`. */
export interface PublicClient {
  clientId: string
  lastPong: number
  /** Last measured ping→pong round-trip (ms). Absent until the first pong. */
  pingRttMs?: number
  authenticated: boolean
  platform?: string
  release?: string
  hostname?: string
  arch?: string
  cpus?: string
  agentVersion?: string
  /** Direct-connection advertisement (present when the agent exposes a P2P endpoint). */
  directAddr?: string
  directCertSha256?: string
  directPinRequired?: boolean
}

export interface ClientListPayload {
  clientIds: PublicClient[]
  timestamp: string
}

export interface StatsPayload {
  clientId: string
  data: Record<string, unknown>
}

// --- Telemetry (the `data` of a `stats` frame; mirrors Go telemetry.StatsSample).
// All fields are optional/defensive: servers omit battery/thermal, older agents
// omit newer fields. The telemetry parser (services/telemetry.ts) normalizes this.

export interface MemInfo {
  used?: number
  free?: number
  total?: number
}

export interface DiskInfo {
  mount?: string
  fsName?: string
  fsType?: string
  used?: number
  avail?: number
  /** Percent used (0–100), as reported by the agent. */
  capacity?: number
}

export interface BatteryDevice {
  status?: string
  percent?: number
}

export interface BatteryInfo {
  status?: string
  percent?: number
  devices?: BatteryDevice[]
}

export interface ThermalSensor {
  component?: string
  name?: string
  temperature?: number
  high?: number
  critical?: number
}

export interface AlertItem {
  id?: string
  ts?: string
  severity?: string
  category?: string
  message?: string
  source?: string
  count?: number
}

export interface AlertSnapshot {
  alerts?: AlertItem[]
  since?: string
  totalCount?: number
  hasCritical?: boolean
  lastScanTime?: string
}

/** The `data` object of a `stats` frame. */
export interface StatsData {
  cpu?: number
  mem?: MemInfo
  disk?: DiskInfo[]
  battery?: BatteryInfo
  thermal?: ThermalSensor[]
  alerts?: AlertSnapshot
  hostname?: string
  platform?: string
  cpus?: number
  uptimeSec?: number
  ts?: string
}

/** Payload of an `alerts` frame (control plane re-broadcasts the agent's snapshot). */
export interface AlertsPayload {
  clientId: string
  data: AlertSnapshot
}

/** One child entry in `dir_list_response`. Optional fields omitted when zero. */
export interface DirListEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mode?: string
  modTime?: string
  isSymlink?: boolean
  linkTarget?: string
}

export interface DirListResponse {
  clientId: string
  requestId: string
  mode: string
  path: string
  entries: DirListEntry[]
  error?: string
}

export interface FilePutResult {
  clientId: string
  requestId: string
  ok: boolean
  path?: string
  size?: number
  error?: string
}

export interface FileDeleteResult {
  clientId: string
  requestId: string
  path: string
  ok: boolean
  error?: string
}

export interface FileChmodResult {
  clientId: string
  requestId: string
  ok: boolean
  path?: string
  mode?: string
  error?: string
}

// Proposed file-read extension (docs/PROTOCOL.md "PROTOCOL GAP").
export interface FileGetChunk {
  clientId: string
  requestId: string
  offset: number
  data: string // base64
}

export interface FileGetResult {
  clientId: string
  requestId: string
  ok: boolean
  path?: string
  size?: number
  error?: string
}

export interface FileMkdirResult {
  clientId: string
  requestId: string
  ok: boolean
  path?: string
  error?: string
}

export interface FileRenameResult {
  clientId: string
  requestId: string
  ok: boolean
  path?: string
  error?: string
}

/** Result of a generic `exec_request` (run an allowlisted command on the agent). */
export interface ExecResult {
  clientId: string
  requestId: string
  ok: boolean
  code: number
  stdout: string
  stderr: string
  error?: string
}

export interface ShellStarted {
  session: string
  clientId: string
}

export interface ShellOutput {
  clientId: string
  session: string
  data: string // raw utf-8 passthrough, not base64
}

export interface ShellClosed {
  clientId: string
  session: string
  reason?: string
}

export interface ShellError {
  message: string
}

export interface AuthStatus {
  authenticated: boolean
  user: Record<string, unknown> | null
}
