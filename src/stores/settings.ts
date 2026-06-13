import { defineStore } from 'pinia'
import { defaultEditorSettings, type EditorSettings } from '@/cm/setup'
import { loadValue, saveValue } from '@/services/store'

export interface IndexingSettings {
  ollamaUrl: string
  embedModel: string
  /** Last index opened in the search panel (local LanceDB dir). */
  indexPath: string
}

const defaultIndexing: IndexingSettings = {
  ollamaUrl: 'http://localhost:11434',
  embedModel: 'nomic-embed-text',
  indexPath: '',
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    editor: { ...defaultEditorSettings } as EditorSettings,
    indexing: { ...defaultIndexing } as IndexingSettings,
    loaded: false,
  }),

  actions: {
    async load() {
      const editor = await loadValue<Partial<EditorSettings>>('editorSettings', {})
      const indexing = await loadValue<Partial<IndexingSettings>>('indexingSettings', {})
      this.editor = { ...defaultEditorSettings, ...editor }
      this.indexing = { ...defaultIndexing, ...indexing }
      this.loaded = true
    },

    async update(patch: Partial<EditorSettings>) {
      this.editor = { ...this.editor, ...patch }
      await saveValue('editorSettings', this.editor)
    },

    async updateIndexing(patch: Partial<IndexingSettings>) {
      this.indexing = { ...this.indexing, ...patch }
      await saveValue('indexingSettings', this.indexing)
    },

    /** Global settings merged with a project's overrides. */
    effective(override?: Partial<EditorSettings>): EditorSettings {
      return { ...this.editor, ...(override ?? {}) }
    },
  },
})
