import { reactive } from 'vue'

/**
 * Bridge for shell actions the stores can't own directly — selecting a column-2
 * tab from a store action. The Project column registers the callback on mount;
 * callers no-op until then, exactly like `services/dock.ts`.
 */
export const shell = reactive<{
  /** Select a contributed column-2 view by its id (e.g. the Project focus tab). */
  focusProjectTab: ((viewId: string) => void) | null
}>({
  focusProjectTab: null,
})
