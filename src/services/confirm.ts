import { reactive } from 'vue'

/**
 * A single confirmation dialog shared across the app. `confirm()` returns a
 * promise that resolves true/false when the user chooses. One <ConfirmDialog>
 * instance renders the active request.
 */
interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger: boolean
}

interface ConfirmState extends ConfirmRequest {
  open: boolean
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  title: '',
  message: '',
  confirmLabel: 'Confirm',
  danger: false,
})

let resolver: ((ok: boolean) => void) | null = null

export function confirm(req: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  // Resolve any prior pending request as cancelled before opening a new one.
  resolver?.(false)
  confirmState.title = req.title
  confirmState.message = req.message
  confirmState.confirmLabel = req.confirmLabel ?? 'Confirm'
  confirmState.danger = req.danger ?? false
  confirmState.open = true
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

export function resolveConfirm(ok: boolean) {
  confirmState.open = false
  resolver?.(ok)
  resolver = null
}
