Perfect. Now I have all the information I need. Let me create a comprehensive Socket.IO protocol reference document:

---

# Socket.IO Agent Protocol Reference

Complete protocol specification for the bidirectional WebSocket communication between the compute-agent (client) and control-plane server.

## 1. Connection & Authentication

### Connection Establishment

**URL Format:**
```
ws://  or wss://{SERVER_URL}{SOCKET_PATH}?clientId={clientId}&ts={timestamp}&sig={signature}
```

**Configuration:**
- `ServerURL`: Server base URL (e.g., `https://control.example.com`)
- `ClientID`: Unique agent identifier (required, non-empty)
- `AuthToken`: Shared secret for HMAC authentication (required, non-empty)
- `SocketPath`: WebSocket endpoint path (default: `/ws/agent`, configurable)
- Transport: Plain WebSocket (not Socket.IO protocol layer)
- Read limit: 1 MB per message

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 37-53, 155-170

### HMAC Authentication Handshake

The agent authenticates by sending HMAC-SHA256 signed credentials in the WebSocket URL query parameters during dial.

**Query Parameters (all required):**
- `clientId` (string): Agent's client ID
- `ts` (int64): Milliseconds since Unix epoch when signed
- `sig` (string): Hex-encoded HMAC-SHA256 signature

**Signature Computation:**
```
payload = "{\"clientId\":\"<clientId>\",\"ts\":<timestamp>}"
sig = hex(HMAC-SHA256(authToken, payload))
```

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 646-666

### Session Nonce & Command Signing

After connection, server sends `hello_ack` with a session nonce. This nonce is used to derive a per-session key for command signature verification.

**Session Key Derivation (agent-side):**
```
sessionKey = HMAC-SHA256(authToken, "cmdsig-session-v1|" + sessionNonce)
```

All subsequent server→agent commands must include cryptographic signatures using this session key. Command signing is **mandatory** — unsigned commands are rejected.

**Source:** `/Users/austinkregel/src/compute-agent/pkg/cmdsig/cmdsig.go` lines 306-316, `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 581-606

---

## 2. Message Envelope Format

### Transport Layer Message

All WebSocket messages use this JSON envelope:

```json
{
  "event": "<event_name>",
  "data": <payload_object>
}
```

**Fields:**
- `event` (string): Event name identifier
- `data` (object): Event-specific payload (JSON-serialized)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 384-387

### Signed Command Envelope (Server→Agent)

All commands from server to agent arrive wrapped in a `signed_command` event with cryptographic metadata:

```json
{
  "event": "signed_command",
  "data": {
    "event": "<actual_event_name>",
    "seq": <monotonic_sequence_number>,
    "ts": <milliseconds_since_epoch>,
    "sig": "<hex_encoded_hmac_sha256>",
    "payload": <command_payload_object>
  }
}
```

**SignedEnvelope fields:**
- `event` (string): The actual command name (e.g., `"admin_run"`, `"shell_start"`)
- `seq` (int64): Monotonically increasing sequence number (for replay detection)
- `ts` (int64): Unix timestamp in milliseconds (for freshness check, ±5 minutes tolerance by default)
- `sig` (string): Hex-encoded HMAC-SHA256(sessionKey, canonicalPayload)
- `payload` (object): The actual command data (raw JSON object)

**Signature Verification:**
1. Verify `ts` is within max clock skew (default ±5 minutes from agent's now)
2. Compute `canonical = event|seq|ts|sortedJSON(payload)`
3. Verify `sig == hex(HMAC-SHA256(sessionKey, canonical))`
4. Verify `seq` is monotonically increasing (out-of-order tolerance: ±100)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/cmdsig/cmdsig.go` lines 64-82, 169-237

---

## 3. Server→Agent Events (Signed Commands)

All server→agent commands arrive as signed command envelopes. The agent verifies the signature before dispatching to the appropriate handler.

### Connection Handshake

#### Event: `hello_ack`
**Origin:** Server (unsigned, received during initial connect handshake)

**Payload Structure:**
```json
{
  "sessionNonce": "<32_byte_hex_string>"
}
```

**Fields:**
- `sessionNonce` (string, optional): Server-generated random nonce used to derive per-session signing key

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 255, dispatch at `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 581-606

**Agent Actions:**
1. Derive session key: `HMAC-SHA256(authToken, "cmdsig-session-v1|" + sessionNonce)`
2. Mark connection as authenticated (`helloAcked = true`)
3. Call user-provided `Hello` callback
4. Emit `variant_status` immediately
5. Check for agent updates (if available)
6. Emit telemetry immediately via `telemetry.EmitNow()`

---

### Admin Command Execution

#### Event: `admin_run`
**Wire Name:** `"admin_run"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "token": "<auth_token_string>",
  "cmd": {
    "command": "<command_line_string>",
    "timeoutSec": <integer>,
    "cwd": "<optional_working_directory>"
  }
}
```

**Fields:**
- `token` (string): Admin authentication token (matched against config if `admin.requireToken=true`)
- `cmd.command` (string): Shell command to execute (must be in allow-list)
- `cmd.timeoutSec` (int): Timeout in seconds; ≤0 uses default from config
- `cmd.cwd` (string, optional): Working directory (empty = inherit agent's cwd)

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 330-393

**Execution Rules:**
- Commands must pass allow-list check (configured in `admin.allowed`)
- Default timeout: `config.Admin.DefaultTimeoutSec`
- Rate limiting: Blocked if too many concurrent requests
- Output: Stdout + stderr captured and returned
- Exit code: 1 (generic error), 124 (timeout), 126 (blocked/invalid), actual exit code if command succeeded

**Response Event:** `admin_result` (see Agent→Server section)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/admin/runner.go` lines 129-242

---

### Interactive Shell (PTY) Operations

#### Event: `shell_start`
**Wire Name:** `"shell_start"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>"
}
```

**Fields:**
- `session` (string): Unique identifier for this shell session

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 116

**Agent Actions:**
- Allocate a PTY (pseudo-terminal)
- Start an interactive shell process
- Begin streaming output to server via `shell_output` events

**Errors:** If allocation fails, emit `shell_closed` with exit code 1 and error reason

**Source:** `/Users/austinkregel/src/compute-agent/pkg/admin/runner.go` lines 250+

---

#### Event: `shell_input`
**Wire Name:** `"shell_input"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>",
  "data": "<base64_or_utf8_encoded_bytes>"
}
```

**Fields:**
- `session` (string): Session ID matching a `shell_start`
- `data` (string): Input data to send to PTY stdin (typically UTF-8, but binary may be base64-encoded)

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 117

**Agent Actions:**
- Write data to PTY stdin
- Forward to running shell process

**Source:** `/Users/austinkregel/src/compute-agent/pkg/admin/runner.go` lines 260+

---

#### Event: `shell_resize`
**Wire Name:** `"shell_resize"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>",
  "cols": <columns_count>,
  "rows": <rows_count>
}
```

**Fields:**
- `session` (string): Session ID
- `cols` (int): New terminal column count
- `rows` (int): New terminal row count

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 118

**Agent Actions:**
- Resize PTY to specified dimensions
- Emits SIGWINCH to shell process

**Source:** `/Users/austinkregel/src/compute-agent/pkg/admin/runner.go` lines 280+

---

#### Event: `shell_close`
**Wire Name:** `"shell_close"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>"
}
```

**Fields:**
- `session` (string): Session ID to close

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 119

**Agent Actions:**
- Terminate PTY session
- Close stdin/stdout/stderr
- Emit `shell_closed` with exit code and reason

**Source:** `/Users/austinkregel/src/compute-agent/pkg/admin/runner.go` lines 290+

---

### Log Tailing

#### Event: `log_tail_start`
**Wire Name:** `"log_tail_start"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>",
  "lines": <number_of_lines>
}
```

**Fields:**
- `session` (string): Unique session ID for this tail stream
- `lines` (int): Number of lines to emit initially; default 10, clamped 1-200

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 120

**Agent Actions:**
- Open agent log file (from config `logging.filePath`)
- Emit last N lines via `log_tail_output` events
- Begin streaming new lines as they appear (~350ms polling interval)
- Continue until `log_tail_stop` or context cancellation

**Polling:** 350ms tick rate, max 64 KB per tick  
**Log Rotation:** If file size decreases, assume rotation; emit `[log rotated]` marker

**Output Events:** `log_tail_output`, `log_tail_closed`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/log_tail.go` lines 19-142

---

#### Event: `log_tail_stop`
**Wire Name:** `"log_tail_stop"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "session": "<unique_session_id>"
}
```

**Fields:**
- `session` (string): Session ID to stop

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 121

**Agent Actions:**
- Cancel the tail context
- Emit `log_tail_closed`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/log_tail.go` lines 43-57

---

### Backup Operations

#### Event: `backup_plan`
**Wire Name:** `"backup_plan"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "planId": "<unique_plan_id>",
  "host": "<optional_remote_host>",
  "user": "<optional_remote_user>",
  "port": <optional_port>,
  "sourceDirs": ["<dir1>", "<dir2>"],
  "destRoot": "<destination_root_path>",
  "ignoreGlobs": ["<glob_pattern1>"]
}
```

**Fields:**
- `planId` (string): Unique identifier for this backup plan
- `host` (string, optional): Remote host (if empty, local backup)
- `user` (string, optional): SSH user for remote
- `port` (int, optional): SSH port for remote
- `sourceDirs` (array of strings): Source directories to backup
- `destRoot` (string): Destination root path
- `ignoreGlobs` (array of strings): File glob patterns to exclude

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 122

**Agent Actions:**
- Validate all source directories exist and are accessible
- Recursively walk source dirs, filtering by `ignoreGlobs`
- Calculate file count and total size
- Collect sample of first 25 files
- Emit `backup_plan` response event with metadata

**Response Event:** `backup_plan` (agent→server, detailed below)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/backup/backup.go` lines 54-75

---

#### Event: `backup_start`
**Wire Name:** `"backup_start"`  
**Origin:** Server (signed command)

**Payload Structure:**
Same as `backup_plan` (above)

**Fields:**
- Same as `backup_plan`

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 123

**Agent Actions:**
- Retrieve previously-planned file list (from `backup_plan`)
- Execute copy operation (local or remote)
- Emit `backup_progress` events as files are copied
- On completion, emit `backup_complete` with final stats

**Source:** `/Users/austinkregel/src/compute-agent/pkg/backup/backup.go` lines 78-96

---

### Directory Listing

#### Event: `dir_list_request`
**Wire Name:** `"dir_list_request"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<unique_request_id>",
  "mode": "<'local'|'remote'>",
  "path": "<directory_path>",
  "host": "<optional_remote_host>",
  "user": "<optional_remote_user>",
  "port": <optional_port>,
  "protocol": "<'ssh'|'smb'|empty>",
  "share": "<optional_smb_share>",
  "profile": "<optional_smb_profile>"
}
```

**Fields:**
- `clientId` (string): Agent's client ID
- `requestId` (string): Correlation ID for response
- `mode` (string): `"local"` or `"remote"`
- `path` (string): Directory path to list (default: user home dir if empty)
- **For remote mode (host required):**
  - `host` (string, required): Remote hostname/IP
  - `user` (string, optional): SSH user
  - `port` (int, optional): SSH port (default 22)
  - `protocol` (string, optional): `"ssh"` (default) or `"smb"`
  - `share` (string, required for SMB): SMB share name
  - `profile` (string, required for SMB): SMB profile name from config

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 128

**Agent Actions:**
1. Validate path
2. For `mode="local"`: 
   - Check against allowed roots (`config.dirBrowse.allowedRoots`)
   - List directory entries
3. For `mode="remote"` with `protocol="ssh"`:
   - Connect via SSH
   - List directory
4. For `mode="remote"` with `protocol="smb"`:
   - Connect using SMB profile credentials
   - List directory
5. Emit `dir_list_response` with entry list

**Response Event:** `dir_list_response` (see Agent→Server section)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 528-662

---

### File Operations

#### Event: `file_put_start`
**Wire Name:** `"file_put_start"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<unique_request_id>",
  "path": "<absolute_file_path>",
  "size": <total_file_size_bytes>,
  "mode": "<optional_permission_mode>",
  "force": <boolean>,
  "overwrite": <boolean>
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `path` (string): Absolute destination file path
- `size` (int64): Expected total file size in bytes
- `mode` (string, optional): Permission mode (e.g., `"0644"`)
- `force` (boolean): Allow writing to protected paths
- `overwrite` (boolean): Overwrite existing files

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 129

**Agent Actions:**
- Validate path and permissions
- Allocate upload buffer
- Emit `file_put_result` with OK status

**Response Event:** `file_put_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 682-703

---

#### Event: `file_put_chunk`
**Wire Name:** `"file_put_chunk"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "requestId": "<request_id>",
  "offset": <byte_offset>,
  "data": "<base64_encoded_chunk>"
}
```

**Fields:**
- `requestId` (string): Correlation ID matching `file_put_start`
- `offset` (int64): Byte offset within the file
- `data` (string): Base64-encoded chunk data

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 130

**Agent Actions:**
- Write chunk to upload buffer at specified offset
- On error, cancel upload and emit `file_put_result` with error

**Response Event:** `file_put_result` (on error only)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 705-719

---

#### Event: `file_put_finish`
**Wire Name:** `"file_put_finish"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "requestId": "<request_id>",
  "checksum": "<optional_sha256_hex>"
}
```

**Fields:**
- `requestId` (string): Correlation ID
- `checksum` (string, optional): SHA256 checksum for verification

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 131

**Agent Actions:**
- Flush buffered data to disk
- Verify checksum if provided
- Emit `file_put_result` with final status and file size

**Response Event:** `file_put_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 721-743

---

#### Event: `file_delete_request`
**Wire Name:** `"file_delete_request"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<unique_request_id>",
  "path": "<file_or_directory_path>",
  "force": <boolean>,
  "recursive": <boolean>
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `path` (string): File or directory path
- `force` (boolean): Allow deleting protected paths
- `recursive` (boolean): Recursively delete non-empty directories (requires `force=true`)

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 132

**Agent Actions:**
- Validate path permissions
- Delete file or directory
- Emit `file_delete_result` with status

**Response Event:** `file_delete_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 745-766

---

#### Event: `file_chmod_request`
**Wire Name:** `"file_chmod_request"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<unique_request_id>",
  "path": "<file_path>",
  "mode": "<permission_mode>",
  "force": <boolean>
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `path` (string): File path
- `mode` (string): Permission mode (e.g., `"0755"`, `"rwxr-xr-x"`)
- `force` (boolean): Allow chmod on protected paths

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 133

**Agent Actions:**
- Parse and validate permission mode
- Apply to file
- Emit `file_chmod_result` with status

**Response Event:** `file_chmod_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 768-790

---

### SSH Key Synchronization

#### Event: `sync_keys`
**Wire Name:** `"sync_keys"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "user": "<github_username>"
}
```

**Fields:**
- `user` (string): GitHub username to fetch public keys from

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 124

**Agent Actions:**
1. Fetch authorized_keys from `https://github.com/{user}.keys`
2. Validate each key line
3. Merge with existing `~/.ssh/authorized_keys`
4. Write atomically with 0600 permissions
5. Emit `keys_sync_result` with count of added keys

**Response Event:** `keys_sync_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 431-448

---

### Agent Self-Update

#### Event: `agent_update`
**Wire Name:** `"agent_update"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "repo": "<optional_github_repo>",
  "tag": "<optional_version_tag>",
  "at": "<optional_timestamp>",
  "variant": "<optional_variant>"
}
```

**Fields:**
- `repo` (string, optional): GitHub repo (default: `"austinkregel/compute-agent"`)
- `tag` (string, optional): Version tag to download (e.g., `"v1.2.3"`)
- `at` (string, optional): Scheduled time (for future scheduling)
- `variant` (string, optional): Binary variant (`"headless"` or `"kiosk"`); keeps current if empty

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 125

**Agent Actions:**
- Download specified release from GitHub
- Extract and replace agent binary
- On success, exec() into new binary (process replacement)
- On failure, emit `agent_update_result` with error

**Response Event:** `agent_update_result` (best-effort; may not send if exec() succeeds)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 450-474

---

### Variant Switching

#### Event: `switch_variant`
**Wire Name:** `"switch_variant"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "variant": "<'headless'|'kiosk'>",
  "repo": "<optional_github_repo>",
  "tag": "<optional_version_tag>"
}
```

**Fields:**
- `variant` (string): Desired variant (`"headless"` or `"kiosk"`)
- `repo` (string, optional): GitHub repo (default: `"austinkregel/compute-agent"`)
- `tag` (string, optional): Version tag (default: current version)

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 126

**Agent Actions:**
- Validate variant is `"headless"` or `"kiosk"`
- Download specified binary
- Replace current executable
- Exec() into new binary
- On failure, emit `variant_switch_result` with error

**Response Event:** `variant_switch_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 476-515

---

### Update Checks

#### Event: `check_updates`
**Wire Name:** `"check_updates"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "at": "<optional_timestamp>"
}
```

**Fields:**
- `at` (string, optional): Scheduled time

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 127

**Agent Actions:**
- Force immediate OS update check (packages, security patches, reboot status)
- Emit `stats` event immediately with updated `Updates` field

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 517-526

---

### Kiosk Operations

#### Event: `kiosk_set`
**Wire Name:** `"kiosk_set"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "requestId": "<optional_request_id>",
  "content": {
    "kind": "<'blank'|'dashboard'|'message'|'url'|'page'>",
    "title": "<optional_title>",
    "text": "<optional_text>",
    "url": "<optional_url>",
    "layout": "<optional_layout_name>",
    "widgets": [
      {
        "type": "<widget_type>",
        "col": <column>,
        "row": <row>,
        "w": <width>,
        "h": <height>,
        "config": {<widget_config>}
      }
    ],
    "units": "<'imperial'|'metric'>"
  },
  "ts": "<optional_timestamp>"
}
```

**Fields:**
- `content.kind` (string): Display mode
  - `"blank"`: Empty display
  - `"dashboard"`: Self-reporting system dashboard
  - `"message"`: Text message display (uses `title`, `text`)
  - `"url"`: Load URL (uses `url`)
  - `"page"`: Custom widget grid (uses `layout`, `widgets`)
- `content.title`, `content.text`: For "message" kind
- `content.url`: For "url" kind (http: or https: only)
- `content.layout`, `content.widgets`: For "page" kind
- `content.units` (string): Unit system for metrics (`"imperial"` or `"metric"`)
- `ts` (string, optional): Timestamp

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 134

**Agent Actions:**
- If kiosk subsystem is not enabled, emit error status
- Otherwise, set display content on kiosk window

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 965-992

---

#### Event: `kiosk_save_layout`
**Wire Name:** `"kiosk_save_layout"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "layout": "<layout_name>",
  "cols": <column_count>,
  "rows": <row_count>,
  "widgets": [
    {
      "type": "<widget_type>",
      "col": <column>,
      "row": <row>,
      "w": <width>,
      "h": <height>,
      "config": {<widget_config>}
    }
  ],
  "units": "<'imperial'|'metric'>",
  "ts": "<optional_timestamp>"
}
```

**Fields:**
- `layout` (string): Layout name identifier
- `cols` (int): Column count in grid
- `rows` (int): Row count in grid
- `widgets` (array): Widget placements
- `units` (string, optional): Unit system
- `ts` (string, optional): Timestamp

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 135

**Agent Actions:**
- Save layout to persistent storage
- Emit `kiosk_layout_saved` response

**Response Event:** `kiosk_layout_saved`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 994-1022

---

#### Event: `kiosk_get_layouts`
**Wire Name:** `"kiosk_get_layouts"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "ts": "<optional_timestamp>"
}
```

**Fields:**
- `ts` (string, optional): Timestamp

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 136

**Agent Actions:**
- Retrieve all saved layouts
- Emit `kiosk_layouts` response with layout map

**Response Event:** `kiosk_layouts`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 1024-1034

---

### Docker/Swarm Operations

#### Event: `swarm_info_request`
**Wire Name:** `"swarm_info_request"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>"
}
```

**Fields:**
- `clientId` (string): Agent client ID

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 138

**Agent Actions:**
- Query Docker Swarm status
- Emit `swarm_info_response` with status data

**Response Event:** `swarm_info_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 37-50

---

#### Event: `swarm_init`
**Wire Name:** `"swarm_init"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "advertiseAddr": "<optional_advertise_address>",
  "listenAddr": "<optional_listen_address>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `advertiseAddr` (string, optional): Address to advertise to other nodes
- `listenAddr` (string, optional): Address to listen on

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 139

**Agent Actions:**
- Initialize Docker Swarm on this node
- Emit `swarm_init_result` with node ID or error

**Response Event:** `swarm_init_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 52-70

---

#### Event: `swarm_join`
**Wire Name:** `"swarm_join"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "joinToken": "<swarm_join_token>",
  "remoteAddrs": ["<addr1>", "<addr2>"],
  "advertiseAddr": "<optional_advertise_address>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `joinToken` (string): Swarm join token
- `remoteAddrs` (array): Remote manager addresses
- `advertiseAddr` (string, optional): Address to advertise

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 140

**Agent Actions:**
- Join existing Swarm
- Emit `swarm_join_result` with status

**Response Event:** `swarm_join_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 72-89

---

#### Event: `swarm_leave`
**Wire Name:** `"swarm_leave"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "force": <boolean>
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `force` (boolean): Force leave even if manager

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 141

**Agent Actions:**
- Leave current Swarm
- Emit `swarm_leave_result` with status

**Response Event:** `swarm_leave_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 91-108

---

#### Event: `swarm_node_list`
**Wire Name:** `"swarm_node_list"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>"
}
```

**Fields:**
- `clientId` (string): Agent client ID

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 142

**Agent Actions:**
- List all nodes in Swarm (requires manager role)
- Emit `swarm_node_list_response` with node list

**Response Event:** `swarm_node_list_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 110-131

---

#### Event: `swarm_service_list`
**Wire Name:** `"swarm_service_list"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>"
}
```

**Fields:**
- `clientId` (string): Agent client ID

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 143

**Agent Actions:**
- List all services in Swarm (requires manager role)
- Emit `swarm_service_list_response` with service list

**Response Event:** `swarm_service_list_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 133-154

---

#### Event: `swarm_service_logs`
**Wire Name:** `"swarm_service_logs"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "serviceId": "<service_id>",
  "tail": "<optional_tail_count>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `serviceId` (string): Service ID
- `tail` (string, optional): Number of log lines to tail

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 144

**Agent Actions:**
- Retrieve service logs (max 256 KB)
- Emit `swarm_service_logs_response` with log data

**Response Event:** `swarm_service_logs_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 156-178

---

#### Event: `swarm_network_list`
**Wire Name:** `"swarm_network_list"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>"
}
```

**Fields:**
- `clientId` (string): Agent client ID

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 145

**Agent Actions:**
- List all Docker networks
- Emit `swarm_network_list_response` with network list

**Response Event:** `swarm_network_list_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 180-197

---

#### Event: `swarm_stack_list`
**Wire Name:** `"swarm_stack_list"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>"
}
```

**Fields:**
- `clientId` (string): Agent client ID

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 146

**Agent Actions:**
- List all deployed stacks (requires manager role)
- Emit `swarm_stack_list_response` with stack list

**Response Event:** `swarm_stack_list_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 199-220

---

### Container Operations

#### Event: `container_inventory`
**Wire Name:** `"container_inventory"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `token` (string): Authentication token

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 148

**Agent Actions:**
- List all containers
- Emit `container_inventory_response` with container list and stats

**Response Event:** `container_inventory_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_deploy.go` lines 12-41

---

#### Event: `stack_status`
**Wire Name:** `"stack_status"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "stackName": "<stack_name>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `token` (string): Authentication token
- `stackName` (string): Name of stack to query

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 149

**Agent Actions:**
- Check status of named stack
- Emit `stack_status_response` with status data

**Response Event:** `stack_status_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_deploy.go` lines 43-62

---

#### Event: `compose_scan`
**Wire Name:** `"compose_scan"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "directory": "<directory_to_scan>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `token` (string): Authentication token
- `directory` (string): Directory to recursively scan for compose files

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 150

**Agent Actions:**
- Walk directory tree
- Find docker-compose.yml/yaml and compose.yml/yaml files
- Skip .git, node_modules, vendor directories
- Emit `compose_scan_response` with file list

**Response Event:** `compose_scan_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_compose.go` lines 11-66

---

#### Event: `compose_parse`
**Wire Name:** `"compose_parse"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "files": [<file_paths>]
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `token` (string): Authentication token
- `files` (array): File paths to parse

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 151

**Agent Actions:**
- Parse compose files (currently not implemented)
- Emit `compose_parse_response` with error or parsed data

**Response Event:** `compose_parse_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_compose.go` lines 68-74

---

#### Event: `container_logs`
**Wire Name:** `"container_logs"`  
**Origin:** Server (signed command)

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "containerId": "<container_id>",
  "tail": "<optional_line_count>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `token` (string): Authentication token
- `containerId` (string): Container ID to retrieve logs from
- `tail` (string, optional): Number of lines to tail (default: `"100"`)

**Handler:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` line 152

**Agent Actions:**
- Retrieve container logs (max 256 KB)
- Emit `container_logs_response` with log data

**Response Event:** `container_logs_response`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_logs.go` (lines 1-30+)

---

### Keepalive & Heartbeat

#### Event: `ping` (unsigned)
**Wire Name:** `"ping"`  
**Origin:** Server (unsigned)

**Payload Structure:**
```json
{
  "ts": <milliseconds_since_epoch>
}
```

**Fields:**
- `ts` (int64): Server's timestamp in milliseconds

**Handler:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 608-617

**Agent Actions:**
- Immediately respond with `pong` event echoing the timestamp

**Response Event:** `pong`

**Proactive Behavior:**
- Agent sends proactive `ping` events if idle for > `PongTimeout / 2`
- Default: ping every 45 seconds if no other traffic
- Interval: `HeartbeatInterval` (configurable, default 20 seconds)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 1105-1136

---

## 4. Agent→Server Events (Emitted by Agent)

All agent-emitted events are sent via the plain JSON message envelope (not signed).

### Connection & Metadata

#### Event: `pong`
**Wire Name:** `"pong"`  
**Emitted:** In response to server `ping` events

**Payload Structure:**
```json
{
  "ts": <milliseconds_since_epoch>
}
```

**Fields:**
- `ts` (int64): Echoed timestamp from the server's ping

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` line 617

---

#### Event: `variant_status`
**Wire Name:** `"variant_status"`  
**Emitted:** Immediately after `hello_ack` handshake

**Payload Structure:**
```json
{
  "current": "<'headless'|'kiosk'>",
  "desired": "<'headless'|'kiosk'>",
  "kioskAvailable": <boolean>,
  "lastSwitchError": "<optional_error_message>",
  "lastSwitchAttempt": "<optional_rfc3339_timestamp>"
}
```

**Fields:**
- `current` (string): Variant of running binary (`"headless"` or `"kiosk"`)
- `desired` (string): Configured preferred variant
- `kioskAvailable` (boolean): Whether kiosk subsystem is available in this binary
- `lastSwitchError` (string, optional): Error message from last switch attempt
- `lastSwitchAttempt` (string, optional): RFC3339 timestamp of last attempt

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 268-286

---

### Admin Command Results

#### Event: `admin_result`
**Wire Name:** `"admin_result"`  
**Emitted:** After `admin_run` command completes

**Payload Structure:**
```json
{
  "token": "<auth_token_from_request>",
  "command": "<executed_command_string>",
  "result": {
    "stdout": "<stdout_data>",
    "stderr": "<stderr_data>",
    "summary": {
      "code": <exit_code>,
      "durationMs": <milliseconds>
    },
    "error": "<optional_error_message>"
  }
}
```

**Fields:**
- `token` (string): Echo of the request token
- `command` (string): Echo of the executed command
- `result.stdout` (string): Command stdout
- `result.stderr` (string): Command stderr
- `result.summary.code` (int): Exit code (0 = success, 124 = timeout, 126 = blocked, 1 = generic error)
- `result.summary.durationMs` (int64): Execution duration in milliseconds
- `result.error` (string, optional): Error message if command failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 330-393

---

#### Event: `command_rejected`
**Wire Name:** `"command_rejected"`  
**Emitted:** When signed command fails verification

**Payload Structure:**
```json
{
  "event": "<command_event_name>",
  "seq": <sequence_number>,
  "error": "<error_reason>"
}
```

**Fields:**
- `event` (string): Event name that failed verification
- `seq` (int64): Sequence number of rejected command
- `error` (string): Rejection reason (invalid signature, stale command, replay detected, etc.)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 629-633

---

### Shell Output & Lifecycle

#### Event: `shell_output`
**Wire Name:** `"shell_output"`  
**Emitted:** Continuously as PTY output is produced

**Payload Structure:**
```json
{
  "session": "<session_id>",
  "data": "<utf8_encoded_text>"
}
```

**Fields:**
- `session` (string): Session ID matching `shell_start`
- `data` (string): PTY output data (typically UTF-8)

**Encoding:** Data is sent as UTF-8 string; binary output may be corrupted

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 792-797

---

#### Event: `shell_closed`
**Wire Name:** `"shell_closed"`  
**Emitted:** When shell session terminates

**Payload Structure:**
```json
{
  "session": "<session_id>",
  "code": <exit_code>,
  "reason": "<termination_reason>"
}
```

**Fields:**
- `session` (string): Session ID
- `code` (int): Shell process exit code
- `reason` (string): Termination reason (e.g., "process exited", "timeout", "operator closed", error message)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 799-805

---

### Log Tail Output & Lifecycle

#### Event: `log_tail_output`
**Wire Name:** `"log_tail_output"`  
**Emitted:** Continuously as new log lines appear

**Payload Structure:**
```json
{
  "session": "<session_id>",
  "data": "<log_lines_string>",
  "ts": "<rfc3339_nano_timestamp>"
}
```

**Fields:**
- `session` (string): Session ID matching `log_tail_start`
- `data` (string): Log data (one or more lines with newlines)
- `ts` (string): RFC3339 nanosecond timestamp when emitted

**Special Cases:**
- Log rotation: Agent emits `"\n[log rotated]\n"` marker if file shrinks

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/log_tail.go` lines 191-197

---

#### Event: `log_tail_closed`
**Wire Name:** `"log_tail_closed"`  
**Emitted:** When log tail session ends

**Payload Structure:**
```json
{
  "session": "<session_id>",
  "reason": "<closure_reason>",
  "ts": "<rfc3339_nano_timestamp>"
}
```

**Fields:**
- `session` (string): Session ID
- `reason` (string): Reason for closure (e.g., "stopped", error message)
- `ts` (string): RFC3339 nanosecond timestamp

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/log_tail.go` lines 199-205

---

### Directory Listing Response

#### Event: `dir_list_response`
**Wire Name:** `"dir_list_response"`  
**Emitted:** Response to `dir_list_request`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<request_id>",
  "mode": "<'local'|'remote'>",
  "path": "<resolved_absolute_path>",
  "entries": [
    {
      "name": "<filename>",
      "type": "<'file'|'dir'>",
      "size": <file_size_bytes>,
      "mode": "<unix_permission_string>",
      "modTime": "<rfc3339_timestamp>",
      "isSymlink": <boolean>,
      "linkTarget": "<symlink_target_path>"
    }
  ],
  "error": "<optional_error_message>"
}
```

**Fields:**
- `clientId` (string): Echo of request's clientId
- `requestId` (string): Echo of request's requestId
- `mode` (string): Echo of request mode
- `path` (string): Canonical absolute path listed
- `entries` (array): Directory entries
  - `name` (string): Filename
  - `type` (string): `"file"` or `"dir"`
  - `size` (int64): File size in bytes (omitted for dirs)
  - `mode` (string): Unix permission string (e.g., `"drwxr-xr-x"`)
  - `modTime` (string): RFC3339 modification time
  - `isSymlink` (boolean): True if entry is a symbolic link
  - `linkTarget` (string): Target path if symlink (omitted if not symlink)
- `error` (string, optional): Error message if listing failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 528-662

---

### File Operation Results

#### Event: `file_put_result`
**Wire Name:** `"file_put_result"`  
**Emitted:** Response to `file_put_start`, `file_put_chunk`, `file_put_finish`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<request_id>",
  "ok": <boolean>,
  "path": "<file_path>",
  "size": <total_file_size>,
  "error": "<optional_error_message>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `ok` (boolean): Success flag
- `path` (string, optional): File path (populated on success)
- `size` (int64, optional): Final file size in bytes
- `error` (string, optional): Error message if failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 682-743

---

#### Event: `file_delete_result`
**Wire Name:** `"file_delete_result"`  
**Emitted:** Response to `file_delete_request`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<request_id>",
  "ok": <boolean>,
  "path": "<file_or_dir_path>",
  "error": "<optional_error_message>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `ok` (boolean): Success flag
- `path` (string): Path that was deleted
- `error` (string, optional): Error message if failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 745-766

---

#### Event: `file_chmod_result`
**Wire Name:** `"file_chmod_result"`  
**Emitted:** Response to `file_chmod_request`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "requestId": "<request_id>",
  "ok": <boolean>,
  "path": "<file_path>",
  "mode": "<permission_mode>",
  "error": "<optional_error_message>"
}
```

**Fields:**
- `clientId` (string): Agent client ID
- `requestId` (string): Correlation ID
- `ok` (boolean): Success flag
- `path` (string, optional): File path (populated on success)
- `mode` (string, optional): Applied permission mode
- `error` (string, optional): Error message if failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 768-790

---

### SSH Key Sync Result

#### Event: `keys_sync_result`
**Wire Name:** `"keys_sync_result"`  
**Emitted:** Response to `sync_keys` command

**Payload Structure:**
```json
{
  "user": "<github_username>",
  "ok": <boolean>,
  "added": <count_of_new_keys>,
  "ms": <duration_milliseconds>,
  "error": "<optional_error_message>"
}
```

**Fields:**
- `user` (string): GitHub username that was synced
- `ok` (boolean): Success flag
- `added` (int, optional): Number of new keys added to authorized_keys
- `ms` (int64, optional): Operation duration in milliseconds
- `error` (string, optional): Error message if failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 431-448

---

### Agent Update Results

#### Event: `agent_update_result`
**Wire Name:** `"agent_update_result"`  
**Emitted:** Best-effort response to `agent_update` (may not emit if exec() succeeds)

**Payload Structure:**
```json
{
  "ok": <boolean>,
  "repo": "<repo_name>",
  "tag": "<version_tag>",
  "variant": "<binary_variant>",
  "error": "<error_code>",
  "detail": "<error_detail_message>",
  "ts": "<rfc3339_timestamp>"
}
```

**Fields:**
- `ok` (boolean): Success flag (true = successful update; false = failure)
- `repo` (string): GitHub repo used
- `tag` (string): Version tag applied
- `variant` (string): Binary variant
- `error` (string): Error code/name if failed
- `detail` (string): Human-readable error detail
- `ts` (string): RFC3339 timestamp

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 450-474

---

#### Event: `variant_switch_result`
**Wire Name:** `"variant_switch_result"`  
**Emitted:** Best-effort response to `switch_variant`

**Payload Structure:**
```json
{
  "ok": <boolean>,
  "repo": "<repo_name>",
  "tag": "<version_tag>",
  "variant": "<binary_variant>",
  "error": "<error_code>",
  "detail": "<error_detail_message>",
  "ts": "<rfc3339_timestamp>"
}
```

**Fields:**
- Same as `agent_update_result`

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 476-515

---

### Kiosk Events

#### Event: `kiosk_status`
**Wire Name:** `"kiosk_status"`  
**Emitted:** Whenever kiosk state changes or status is requested

**Payload Structure:**
```json
{
  "kiosk": {
    "running": <boolean>,
    "connected": <boolean>,
    "content": {
      "kind": "<display_kind>",
      "title": "<optional_title>",
      "text": "<optional_text>",
      "url": "<optional_url>",
      "layout": "<optional_layout_name>"
    },
    "lastError": "<optional_error_message>",
    "ts": "<rfc3339_timestamp>"
  }
}
```

**Fields:**
- `kiosk.running` (boolean): Kiosk process is running
- `kiosk.connected` (boolean): Kiosk is connected/online
- `kiosk.content` (object): Current display content
- `kiosk.lastError` (string, optional): Last error if any
- `kiosk.ts` (string): RFC3339 timestamp

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 1040-1062

---

#### Event: `kiosk_layout_saved`
**Wire Name:** `"kiosk_layout_saved"`  
**Emitted:** Response to `kiosk_save_layout`

**Payload Structure:**
```json
{
  "layout": "<layout_name>",
  "ok": <boolean>,
  "error": "<optional_error_message>"
}
```

**Fields:**
- `layout` (string): Layout name
- `ok` (boolean): Success flag
- `error` (string, optional): Error message if failed

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 994-1022

---

#### Event: `kiosk_layouts`
**Wire Name:** `"kiosk_layouts"`  
**Emitted:** Response to `kiosk_get_layouts`

**Payload Structure:**
```json
{
  "layouts": {
    "<layout_name>": {
      "cols": <column_count>,
      "rows": <row_count>,
      "widgets": [
        {
          "type": "<widget_type>",
          "col": <column>,
          "row": <row>,
          "w": <width>,
          "h": <height>,
          "config": {<widget_config>}
        }
      ]
    }
  }
}
```

**Fields:**
- `layouts` (object): Map of saved layout names to layout definitions

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent.go` lines 1024-1034

---

### Docker/Swarm Response Events

#### Event: `swarm_info_response`
**Wire Name:** `"swarm_info_response"`  
**Emitted:** Response to `swarm_info_request`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "data": {
    <swarm_status_data>
  },
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 37-50

---

#### Event: `swarm_init_result`
**Wire Name:** `"swarm_init_result"`  
**Emitted:** Response to `swarm_init`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "nodeId": "<node_id>",
  "success": <boolean>,
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 52-70

---

#### Event: `swarm_join_result`
**Wire Name:** `"swarm_join_result"`  
**Emitted:** Response to `swarm_join`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "success": <boolean>,
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 72-89

---

#### Event: `swarm_leave_result`
**Wire Name:** `"swarm_leave_result"`  
**Emitted:** Response to `swarm_leave`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "success": <boolean>,
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 91-108

---

#### Event: `swarm_node_list_response`
**Wire Name:** `"swarm_node_list_response"`  
**Emitted:** Response to `swarm_node_list`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "nodes": [<node_objects>],
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 110-131

---

#### Event: `swarm_service_list_response`
**Wire Name:** `"swarm_service_list_response"`  
**Emitted:** Response to `swarm_service_list`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "services": [<service_objects>],
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 133-154

---

#### Event: `swarm_service_logs_response`
**Wire Name:** `"swarm_service_logs_response"`  
**Emitted:** Response to `swarm_service_logs`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "serviceId": "<service_id>",
  "logs": "<log_data_string>",
  "error": "<optional_error>"
}
```

**Fields:**
- `logs` (string): Service logs (max 256 KB)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 156-178

---

#### Event: `swarm_network_list_response`
**Wire Name:** `"swarm_network_list_response"`  
**Emitted:** Response to `swarm_network_list`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "networks": [<network_objects>],
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 180-197

---

#### Event: `swarm_stack_list_response`
**Wire Name:** `"swarm_stack_list_response"`  
**Emitted:** Response to `swarm_stack_list`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "stacks": [<stack_objects>],
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_docker.go` lines 199-220

---

### Container Operation Events

#### Event: `container_inventory_response`
**Wire Name:** `"container_inventory_response"`  
**Emitted:** Response to `container_inventory`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "containers": [<container_objects>],
  "total": <total_count>,
  "managed": <managed_count>,
  "swarm": <swarm_managed_count>,
  "unmanaged": <unmanaged_count>,
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_deploy.go` lines 12-41

---

#### Event: `stack_status_response`
**Wire Name:** `"stack_status_response"`  
**Emitted:** Response to `stack_status`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "data": {<stack_status_data>},
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_deploy.go` lines 43-62

---

#### Event: `compose_scan_response`
**Wire Name:** `"compose_scan_response"`  
**Emitted:** Response to `compose_scan`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "directory": "<scanned_directory>",
  "files": [
    {
      "file": "<relative_path>",
      "path": "<absolute_path>",
      "size": <file_size_bytes>
    }
  ],
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_compose.go` lines 11-66

---

#### Event: `compose_parse_response`
**Wire Name:** `"compose_parse_response"`  
**Emitted:** Response to `compose_parse`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "token": "<auth_token>",
  "error": "<optional_error>"
}
```

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_compose.go` lines 68-74

---

#### Event: `container_logs_response`
**Wire Name:** `"container_logs_response"`  
**Emitted:** Response to `container_logs`

**Payload Structure:**
```json
{
  "clientId": "<agent_client_id>",
  "containerId": "<container_id>",
  "logs": "<log_data_string>",
  "error": "<optional_error>"
}
```

**Fields:**
- `logs` (string): Container logs (max 256 KB)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_logs.go`

---

#### Event: `container_event`
**Wire Name:** `"container_event"`  
**Emitted:** Asynchronously whenever a container lifecycle event occurs (real-time stream)

**Payload Structure:**
```json
{
  "containerId": "<container_id>",
  "containerName": "<container_name>",
  "action": "<action_type>",
  "stackName": "<optional_stack_name>",
  "service": "<optional_service_name>",
  "ts": "<rfc3339_timestamp>"
}
```

**Fields:**
- `containerId` (string): Container ID
- `containerName` (string): Container display name
- `action` (string): Action type (e.g., `"start"`, `"stop"`, `"die"`, `"create"`)
- `stackName` (string, optional): Associated stack name
- `service` (string, optional): Associated service name
- `ts` (string): RFC3339 timestamp

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_deploy.go` lines 64-80

---

#### Event: `container_metrics`
**Wire Name:** `"container_metrics"`  
**Emitted:** Periodically (every 30 seconds by default) with live container metrics

**Payload Structure:**
```json
{
  "metrics": [
    {
      "containerId": "<container_id>",
      "name": "<container_name>",
      "cpuPercent": <cpu_percent>,
      "memoryUsed": <memory_bytes>,
      "memoryLimit": <memory_limit_bytes>,
      "memoryPercent": <memory_percent>,
      "networkIn": <bytes>,
      "networkOut": <bytes>,
      "ioRead": <bytes>,
      "ioWrite": <bytes>
    }
  ],
  "ts": "<rfc3339_timestamp>"
}
```

**Fields:**
- `metrics` (array): Container metrics samples
- `ts` (string): RFC3339 timestamp

**Frequency:** Every 30 seconds (if Docker is available and containers exist)

**Source:** `/Users/austinkregel/src/compute-agent/internal/app/agent_metrics.go`

---

### Telemetry (Stats)

#### Event: `stats`
**Wire Name:** `"stats"`  
**Emitted:** Periodically per configured interval (default: 60 seconds)

**Payload Structure:**
```json
{
  "data": {
    "agentVersion": "<semantic_version>",
    "cpu": <cpu_percent_0_to_100>,
    "mem": {
      "used": <bytes>,
      "free": <bytes>,
      "total": <bytes>
    },
    "load": {
      "load1": <1min_avg>,
      "load5": <5min_avg>,
      "load15": <15min_avg>
    },
    "disk": [
      {
        "mount": "<mount_point>",
        "fsName": "<filesystem_device>",
        "fsType": "<filesystem_type>",
        "used": <bytes>,
        "avail": <bytes>,
        "capacity": <percent>
      }
    ],
    "netIfaces": [
      {
        "name": "<interface_name>",
        "family": "<'IPv4'|'IPv6'>",
        "address": "<ip_address>",
        "cidr": "<cidr_notation>",
        "internal": <boolean>
      }
    ],
    "hostname": "<hostname>",
    "platform": "<platform_name>",
    "release": "<os_version>",
    "arch": "<processor_architecture>",
    "cpus": <logical_cpu_count>,
    "uptimeSec": <seconds>,
    "lastReboot": "<rfc3339_timestamp>",
    "kernelVersion": "<kernel_version>",
    "battery": {
      "devices": [
        {
          "id": "<device_id>",
          "status": "<'charging'|'discharging'|'full'|'unknown'>",
          "percent": <0_to_100>,
          "energyNowWh": <watt_hours>,
          "energyFullWh": <watt_hours>,
          "powerNowW": <watts>,
          "energyFullDesignWh": <watt_hours>
        }
      ]
    },
    "thermal": [
      {
        "label": "<sensor_label>",
        "value": <temperature_celsius>,
        "high": <warning_threshold>,
        "critical": <critical_threshold>
      }
    ],
    "updates": {
      "lastChecked": "<rfc3339_timestamp>",
      "available": <update_count>,
      "security": <security_update_count>,
      "restartRequired": <boolean>,
      "checkError": "<optional_error>"
    },
    "securityPatchStatus": "<human_readable_summary>",
    "serviceHealth": {
      "total": <service_count>,
      "running": <running_count>,
      "failed": <failed_count>,
      "criticalFailed": ["<service1>", "<service2>"]
    },
    "timeSyncStatus": "<'synced'|'unsynced'|empty>",
    "alerts": {
      "totalCount": <total_alerts>,
      "hasCritical": <boolean>,
      "alerts": [
        {
          "severity": "<'critical'|'warning'>",
          "category": "<category>",
          "message": "<alert_message>",
          "timestamp": "<rfc3339_timestamp>"
        }
      ]
    },
    "docker": {
      "available": <boolean>,
      "version": "<docker_version>",
      "swarmEnabled": <boolean>,
      "swarmRole": "<'manager'|'worker'|empty>",
      "nodeId": "<node_id>",
      "containersTotal": <count>,
      "containersRunning": <count>,
      "imageCount": <count>
    },
    "ts": "<rfc3339_timestamp>"
  }
}
```

**Fields:**
- `data.agentVersion` (string): Agent semantic version
- `data.cpu` (float64): CPU utilization percentage (0-100)
- `data.mem` (object): Memory statistics
  - `used` (int64): Used memory in bytes
  - `free` (int64): Free memory in bytes
  - `total` (int64): Total memory in bytes
- `data.load` (object): Load averages
  - `load1`, `load5`, `load15` (float64): 1/5/15-minute load averages
- `data.disk` (array): Disk usage per mount point
- `data.netIfaces` (array): Network interfaces
- `data.hostname` (string): System hostname
- `data.platform` (string): OS platform (e.g., `"linux"`, `"windows"`, `"darwin"`)
- `data.release` (string): OS version
- `data.arch` (string): Processor architecture (e.g., `"x86_64"`)
- `data.cpus` (int): Logical CPU count
- `data.uptimeSec` (int64): System uptime in seconds
- `data.lastReboot` (string): RFC3339 timestamp of last reboot
- `data.kernelVersion` (string): Kernel version
- `data.battery` (object, optional): Battery information
- `data.thermal` (array, optional): Temperature sensors
- `data.updates` (object, optional): OS update status
- `data.securityPatchStatus` (string, optional): Human-readable security patch summary
- `data.serviceHealth` (object, optional): systemd service health (Linux only)
- `data.timeSyncStatus` (string, optional): NTP sync status (Linux only)
- `data.alerts` (object, optional): OS alerts (kernel panics, OOM, etc.)
- `data.docker` (object, optional): Docker/Swarm status
- `data.ts` (string): RFC3339 timestamp of collection

**Frequency:** Configurable interval (default: 60 seconds, min 1 second)

**Source:** `/Users/austinkregel/src/compute-agent/pkg/telemetry/telemetry.go` lines 114-418

---

### Backup Events

Agent emits backup-related events during backup operations (progress, completion, errors). The specific event names are emitted via `transport.Emit()` calls within the backup coordinator.

**Source:** `/Users/austinkregel/src/compute-agent/pkg/backup/backup.go`

---

## 5. Reconnection & Resilience

**Exponential Backoff:**
- Initial: 1 second
- Max: 30 seconds
- Resets to min on successful `hello_ack`

**Read Limit:**
- 1 MB per WebSocket message (for file chunk handling)

**Timeout:**
- Pong timeout: 90 seconds (configurable)
- Proactive ping interval: ~45 seconds (if idle)

**Command Signing:**
- Mandatory; all server→agent commands require valid signatures
- Replay detection: Monotonic sequence numbers with ±100 tolerance
- Clock skew tolerance: ±5 minutes (configurable)
- Signature computation: HMAC-SHA256(sessionKey, "event|seq|ts|sortedJSON(payload)")

**Source:** `/Users/austinkregel/src/compute-agent/pkg/transport/transport.go` lines 452-557

---

## Summary Table: All Events

| Direction | Event Name | Type | Correlation | Notes |
|-----------|-----------|------|-------------|-------|
| **S→A** | `hello_ack` | Handshake | — | Unsigned, session nonce provided |
| **S→A** | `ping` | Heartbeat | echo ts | Unsigned |
| **A→S** | `pong` | Heartbeat | echo ts | Response to ping |
| | | | | |
| **S→A** | `admin_run` | Signed | — | Command execution |
| **A→S** | `admin_result` | — | token + command | Command output |
| **A→S** | `command_rejected` | — | seq | Signature verification failed |
| | | | | |
| **S→A** | `shell_start` | Signed | session | PTY allocation |
| **S→A** | `shell_input` | Signed | session | PTY stdin |
| **S→A** | `shell_resize` | Signed | session | PTY resize |
| **S→A** | `shell_close` | Signed | session | PTY close |
| **A→S** | `shell_output` | — | session | PTY output stream |
| **A→S** | `shell_closed` | — | session | PTY exit notification |
| | | | | |
| **S→A** | `log_tail_start` | Signed | session | Log streaming start |
| **S→A** | `log_tail_stop` | Signed | session | Log streaming stop |
| **A→S** | `log_tail_output` | — | session | Log data stream |
| **A→S** | `log_tail_closed` | — | session | Log stream end |
| | | | | |
| **S→A** | `dir_list_request` | Signed | requestId | List directory (local/remote) |
| **A→S** | `dir_list_response` | — | requestId | Directory listing |
| | | | | |
| **S→A** | `file_put_start` | Signed | requestId | File upload start |
| **S→A** | `file_put_chunk` | Signed | requestId | File data chunk |
| **S→A** | `file_put_finish` | Signed | requestId | File upload complete |
| **A→S** | `file_put_result` | — | requestId | Upload status |
| | | | | |
| **S→A** | `file_delete_request` | Signed | requestId | Delete file/directory |
| **A→S** | `file_delete_result` | — | requestId | Delete status |
| | | | | |
| **S→A** | `file_chmod_request` | Signed | requestId | Change permissions |
| **A→S** | `file_chmod_result` | — | requestId | Chmod status |
| | | | | |
| **S→A** | `sync_keys` | Signed | — | SSH key sync |
| **A→S** | `keys_sync_result` | — | user | Sync result |
| | | | | |
| **S→A** | `backup_plan` | Signed | planId | Backup planning |
| **S→A** | `backup_start` | Signed | planId | Backup execution |
| **A→S** | `backup_plan` | — | planId | Plan result (progress events) |
| | | | | |
| **S→A** | `agent_update` | Signed | — | Self-update request |
| **A→S** | `agent_update_result` | — | — | Update result (best-effort) |
| | | | | |
| **S→A** | `switch_variant` | Signed | — | Binary variant switch |
| **A→S** | `variant_switch_result` | — | — | Switch result (best-effort) |
| | | | | |
| **A→S** | `variant_status` | — | — | Emitted after hello_ack |
| | | | | |
| **S→A** | `check_updates` | Signed | — | Force update check |
| | | | | |
| **S→A** | `kiosk_set` | Signed | requestId | Set kiosk display |
| **S→A** | `kiosk_save_layout` | Signed | — | Save kiosk layout |
| **S→A** | `kiosk_get_layouts` | Signed | — | Get saved layouts |
| **A→S** | `kiosk_status` | — | — | Kiosk status updates |
| **A→S** | `kiosk_layout_saved` | — | layout | Layout save confirmation |
| **A→S** | `kiosk_layouts` | — | — | Saved layouts list |
| | | | | |
| **S→A** | `swarm_info_request` | Signed | clientId | Get Swarm status |
| **A→S** | `swarm_info_response` | — | clientId | Swarm status |
| | | | | |
| **S→A** | `swarm_init` | Signed | clientId | Initialize Swarm |
| **A→S** | `swarm_init_result` | — | clientId | Swarm init result |
| | | | | |
| **S→A** | `swarm_join` | Signed | clientId | Join Swarm |
| **A→S** | `swarm_join_result` | — | clientId | Join result |
| | | | | |
| **S→A** | `swarm_leave` | Signed | clientId | Leave Swarm |
| **A→S** | `swarm_leave_result` | — | clientId | Leave result |
| | | | | |
| **S→A** | `swarm_node_list` | Signed | clientId | List Swarm nodes |
| **A→S** | `swarm_node_list_response` | — | clientId | Node list |
| | | | | |
| **S→A** | `swarm_service_list` | Signed | clientId | List Swarm services |
| **A→S** | `swarm_service_list_response` | — | clientId | Service list |
| | | | | |
| **S→A** | `swarm_service_logs` | Signed | clientId | Get service logs |
| **A→S** | `swarm_service_logs_response` | — | clientId | Service logs |
| | | | | |
| **S→A** | `swarm_network_list` | Signed | clientId | List Docker networks |
| **A→S** | `swarm_network_list_response` | — | clientId | Network list |
| | | | | |
| **S→A** | `swarm_stack_list` | Signed | clientId | List stacks |
| **A→S** | `swarm_stack_list_response` | — | clientId | Stack list |
| | | | | |
| **S→A** | `container_inventory` | Signed | clientId + token | List containers |
| **A→S** | `container_inventory_response` | — | clientId + token | Container list |
| | | | | |
| **S→A** | `stack_status` | Signed | clientId + token | Get stack status |
| **A→S** | `stack_status_response` | — | clientId + token | Stack status |
| | | | | |
| **S→A** | `compose_scan` | Signed | clientId + token | Scan for compose files |
| **A→S** | `compose_scan_response` | — | clientId + token | Compose files found |
| | | | | |
| **S→A** | `compose_parse` | Signed | clientId + token | Parse compose files |
| **A→S** | `compose_parse_response` | — | clientId + token | Parse result |
| | | | | |
| **S→A** | `container_logs` | Signed | clientId + token | Get container logs |
| **A→S** | `container_logs_response` | — | clientId + token | Container logs |
| | | | | |
| **A→S** | `container_event` | — | — | Container lifecycle (streaming) |
| **A→S** | `container_metrics` | — | — | Container metrics (periodic) |
| | | | | |
| **A→S** | `stats` | — | — | Telemetry/system metrics (periodic) |

---

## Implementation Notes for UI Client

1. **Connection:**
   - Construct WebSocket URL with HMAC-signed query parameters (`clientId`, `ts`, `sig`)
   - Use plain WebSocket (not Socket.IO library protocol)

2. **Signature Verification:**
   - All server→agent commands arrive in `signed_command` envelope
   - Verify signature before dispatching; reject unsigned commands

3. **Correlation IDs:**
   - Request/response correlation uses explicit IDs in payloads (not Socket.IO ack callbacks)
   - Always echo `requestId`, `clientId`, `token`, or `session` fields in responses

4. **Streaming Events:**
   - `shell_output`, `log_tail_output`, `container_event`, `container_metrics`, `stats` are streaming (not request/response)
   - No correlation ID; identify streams by `session` or other scoped field

5. **Error Handling:**
   - Most responses include an `error` field; check for non-empty before reading data
   - `command_rejected` events indicate signature/freshness failures

6. **Heartbeat:**
   - Respond to `ping` with `pong` immediately
   - Server may send proactive pings if idle

7. **Timeouts:**
   - Set reasonable timeouts for request/response pairs (suggest 30-60 seconds)
   - Handle `shell_closed`, `log_tail_closed` to detect stream termination

---

**End of Protocol Reference**
