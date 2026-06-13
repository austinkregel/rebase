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

  fileService
    .readBytes(clientId, path)
    .then((b) => {
      bytes.value = b
      if (makeUrl) url.value = URL.createObjectURL(new Blob([b], { type: mime }))
    })
    .catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      loading.value = false
    })

  onBeforeUnmount(() => {
    if (url.value) URL.revokeObjectURL(url.value)
  })

  return { bytes, url, loading, error }
}
