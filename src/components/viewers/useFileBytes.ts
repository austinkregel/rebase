import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { fileService } from '@/services/fileService'

/**
 * Load a file's raw bytes for a binary-backed viewer and (optionally) expose
 * them as an object URL for native elements (<img>, <video>, <audio>). The URL
 * is revoked on unmount so blobs don't leak. Viewers that need the bytes
 * directly (zip, pdf) read `bytes`; media/image viewers use `url`.
 */
export function useFileBytes(path: string, clientId: string, mime: string, makeUrl = true) {
  const bytes = shallowRef<Uint8Array | null>(null)
  const url = ref<string | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  // If the component unmounts before readBytes resolves, url.value is still null
  // so onBeforeUnmount has nothing to revoke; the late resolve would then create
  // an object URL that never gets cleaned up. Track cancellation explicitly.
  let cancelled = false

  fileService
    .readBytes(clientId, path)
    .then((b) => {
      if (cancelled) return
      bytes.value = b
      if (makeUrl) url.value = URL.createObjectURL(new Blob([b], { type: mime }))
    })
    .catch((err) => {
      if (cancelled) return
      error.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      if (cancelled) return
      loading.value = false
    })

  onBeforeUnmount(() => {
    cancelled = true
    if (url.value) URL.revokeObjectURL(url.value)
  })

  return { bytes, url, loading, error }
}
