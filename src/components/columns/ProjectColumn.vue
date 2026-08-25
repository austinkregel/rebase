<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch, type Component, type FunctionalComponent } from 'vue'
import { TabGroup, TabList, Tab, TabPanels, TabPanel } from '@headlessui/vue'
import {
  DocumentDuplicateIcon as DocumentDuplicateIconOutline,
  Cog6ToothIcon as Cog6ToothIconOutline,
} from '@heroicons/vue/24/outline'
import { DocumentDuplicateIcon, Cog6ToothIcon } from '@heroicons/vue/20/solid'
import { viewsFor } from '@/services/views'
import { shell } from '@/services/shell'
import FileTree from '../FileTree.vue'
import EditorSettingsForm from '../EditorSettingsForm.vue'

interface TabEntry {
  id: string
  label: string
  icon: FunctionalComponent
  iconActive: FunctionalComponent
  component: Component
  keepMounted?: boolean
}

// Core tabs anchor the column; plugins contribute the middle (e.g. Projects).
const filesTab: TabEntry = {
  id: 'files',
  label: 'Files',
  icon: DocumentDuplicateIconOutline,
  iconActive: DocumentDuplicateIcon,
  component: markRaw(FileTree),
  keepMounted: true,
}
const ideTab: TabEntry = {
  id: 'ide',
  label: 'IDE settings',
  icon: Cog6ToothIconOutline,
  iconActive: Cog6ToothIcon,
  component: markRaw(EditorSettingsForm),
}

const tabs = computed<TabEntry[]>(() => [
  filesTab,
  ...viewsFor('sidebar.project')
    .filter((v) => v.visible?.() ?? true)
    .map((v) => ({
      id: v.id,
      label: v.title,
      icon: v.icon,
      iconActive: v.iconActive ?? v.icon,
      component: v.component,
    })),
  ideTab,
])

// The TabGroup is *controlled* so a store action (enterProjectMode) can select
// the Project tab through the shell bridge. Headless UI is otherwise uncontrolled
// and nothing outside it could switch tabs.
const selectedIndex = ref(0)

// When a conditional tab disappears (leaving project mode) the selected index can
// fall off the end or onto a different tab; clamp it back to the Files tab.
watch(
  () => tabs.value.length,
  (len) => {
    if (selectedIndex.value >= len) selectedIndex.value = 0
  },
)

onMounted(() => {
  shell.focusProjectTab = (viewId: string) => {
    const i = tabs.value.findIndex((t) => t.id === viewId)
    if (i >= 0) selectedIndex.value = i
  }
})
onBeforeUnmount(() => {
  if (shell.focusProjectTab) shell.focusProjectTab = null
})
</script>

<template>
  <TabGroup as="div" :selected-index="selectedIndex" class="flex h-full min-h-0 flex-col bg-surface" @change="selectedIndex = $event">
    <TabList class="flex flex-shrink-0 border-b border-line">
      <Tab v-for="t in tabs" :key="t.id" v-slot="{ selected }" as="template">
        <button
          class="flex border-b-2 py-2 outline-none transition-colors ml-2"
          :class="selected ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-muted'"
          :title="t.label"
          :aria-label="t.label"
        >
          <component :is="selected ? t.iconActive : t.icon" class="size-6" />
        </button>
      </Tab>
    </TabList>
    <TabPanels class="flex min-h-0 flex-1 flex-col">
      <TabPanel
        v-for="t in tabs"
        :key="t.id"
        :unmount="t.keepMounted ? false : undefined"
        class="flex min-h-0 flex-1 flex-col outline-none"
      >
        <component :is="t.component" />
      </TabPanel>
    </TabPanels>
  </TabGroup>
</template>
