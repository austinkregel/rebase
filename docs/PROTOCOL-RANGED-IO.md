# Protocol spec: ranged & partial file I/O (server/agent hand-off)

Status: **spec — client implemented, server/agent pending.** This is the contract
the control plane (`compute-agent-server`) and agent (`compute-agent`) must
implement so the Re:Base client can open files of **any size** and edit the
**achievable subset** of huge files. The client already speaks this protocol
(`src/services/fileService.ts` `readRange`, wire types in
`src/transport/types.ts`, capability gate in `src/stores/agents.ts` `supports()`).
The two Go repos are **independent parallel workstreams**; either capability can
ship on its own.

All messages follow the existing conventions ([PROTOCOL.md](PROTOCOL.md)): one
`{event, data}` JSON frame, **1 MB frame limit**, **≤256 KiB base64 chunks**,
client-generated `requestId` correlation, **no acks**, and a `*_dispatched` relay
ack so a timeout can tell "control plane didn't route" from "agent doesn't
implement it" (as `file_get_dispatched` does today).

## Capability advertisement (do this first)

Add a `capabilities` string array to each agent's entry in the `client_list`
payload (`PublicClient`):

```json
{ "clientId": "...", "capabilities": ["file_get.range", "file_append", "file_patch"] }
```

The client gates every affordance on this (`supports(clientId, cap)`) and, when a
capability is absent, shows an explicit "redeploy the agent" error **instead of
attempting the operation** — there is no silent fallback. Absent/empty ⇒ the
base whole-file protocol only.

`errorCode` (machine-readable, on any `*_result` with `ok:false`):
`not_found | is_dir | permission | too_large | range_unsupported |
stale_precondition | inplace_requires_equal_length | io`.

---

## Phase B — ranged READ (`file_get.range`) → view any size

Extend the existing `file_get` flow with a client-requested window.

**Request** (new optional `offset`/`length`; `maxSize` unchanged):
```
file_get_request { clientId, requestId, path, maxSize?, offset?, length? }
```
- `offset` — start byte (default 0). `length` — max bytes from `offset` (absent ⇒ to EOF).

**Chunks** (unchanged shape; `offset` is now the **absolute file offset**):
```
file_get_chunk { clientId, requestId, offset, data }   // ≤256 KiB base64
```

**Result** (new range/EOF metadata):
```
file_get_result { clientId, requestId, ok, path?, size?, error?, errorCode?,
                  offset?, returned?, eof?, truncated? }
```
- `size` = **total** file size (stat), or `-1` for unknown/streaming (e.g. `/proc`, a growing file).
- `offset` = served window start; `returned` = bytes streamed; `eof` = window reached end of file; `truncated` = window cut short by `maxSize`.

**Agent behavior (`compute-agent`):**
- `stat` first for `size`; serve `[offset, min(offset+length, size))`, further clamped by `maxSize` (`truncated:true` when cut).
- `offset >= size` ⇒ `ok:true`, zero chunks, `returned:0`, `eof:true` (NOT an error — paging UIs probe the tail).
- `length == 0` ⇒ cheap size probe: `ok:true`, zero chunks, `returned:0`.
- Special/growing files (logs, `/proc`, pipes, devices): use non-blocking reads, **never hang**; report `size:-1` when unknown; `eof` reflects only a real EOF.
- An agent that predates this **must not** silently ignore `offset`/`length` and stream the whole file — the client detects that (no range fields on an `offset>0` request) and rejects loudly, but a clean `ok:false, errorCode:"range_unsupported"` is preferred.

**Control plane (`compute-agent-server`):** pass `offset`/`length` through to the agent, relay the new result fields verbatim, keep emitting `file_get_dispatched`.

---

## Phase C — partial WRITE (`file_append`, `file_patch`) → edit the achievable subset

Editing a huge file without a whole-file rewrite decomposes into three cases:

| Edit | In-place? | Primitive |
|---|---|---|
| Append at EOF (logs) | yes, trivially | `file_append` |
| Same-length overwrite of a byte range | yes (`pwrite`) | `file_patch`, `removeLen == insertLen` |
| Length-changing middle edit | **no** — tail must move, O(size) | `file_patch` (agent streams temp+rename) |

### `file_append` (cheapest; O(appended))
```
file_append_start  { clientId, requestId, path, size, expectSize?, expectMtime? }
file_append_chunk  { clientId, requestId, offset, data }   // offset within the appended region
file_append_finish { clientId, requestId }
file_append_result { clientId, requestId, ok, path?, size?, error?, errorCode? }
```
Agent opens `O_APPEND`, streams, `fsync`. No whole-file rewrite regardless of file size.

### `file_patch` (general byte-range editor)
```
file_patch_start  { clientId, requestId, path,
                    edits: [ { offset, removeLen, insertLen } ],  // sorted, non-overlapping, ascending
                    expectSize?, expectMtime?, expectHash?,        // optimistic-concurrency precondition
                    atomic? }                                      // default true
file_patch_chunk  { clientId, requestId, editIndex, offset, data } // insert bytes for edits[editIndex]
file_patch_finish { clientId, requestId }
file_patch_result { clientId, requestId, ok, path?, size?, newHash?, error?, errorCode? }
```
`edits[i] = {offset, removeLen, insertLen}`: at `offset`, delete `removeLen` bytes
and insert `insertLen` streamed bytes. Expresses append (`offset:size,
removeLen:0`), same-length overwrite (`removeLen==insertLen`), insert
(`removeLen:0`), delete (`insertLen:0`), replace (both).

**Agent execution:**
- All edits `removeLen==insertLen` (no shift) **and** `atomic:false` ⇒ in-place `pwrite` per edit — the true "patch without rewriting the file". O(sum insertLen).
- Any size-changing edit ⇒ stream `[0,firstEdit)`, splice edits in order, to a **temp file in the same dir**, `fsync`, **atomic `rename`** over the original. O(file size) — unavoidable; neither side buffers the whole file in RAM.
- Reject `atomic:false` on a size-changing edit with `errorCode:"inplace_requires_equal_length"` (a crash mid-shift corrupts the tail irrecoverably).

**Concurrency:** check `expectSize`/`expectMtime` (cheap) and/or `expectHash`
(strong, O(size)) before applying; on mismatch return `ok:false,
errorCode:"stale_precondition", size:<current>` so the client tells the user to
reload rather than blind-overwrite.

**Control plane:** relay the new `file_append_*` / `file_patch_*` families, register `requestId`, emit the dispatched acks.

---

## Explicitly NOT in this spec

- **Virtualized editing of a file larger than the client editor can hold in one
  string** — needs a new editor document backend (rope/piece-table over paged
  bytes), not a protocol change. The client scopes this out; this spec enables
  *viewing* any size and *editing* the append/same-length subset.
- **Generic middle-insert without a full rewrite** — fundamentally O(size); the
  agent's temp+rename path is the honest implementation.
- **Server-side ranged search** across an unloaded file — a separate future
  primitive (the current `exec` channel can't do it: metacharacters rejected,
  stdout is a frame-bounded string).
