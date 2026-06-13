<script setup lang="ts">
import { TabGroup, TabList, Tab, TabPanels, TabPanel } from '@headlessui/vue'
import { 
  DocumentDuplicateIcon as DocumentDuplicateIconOutline,
  BeakerIcon as BeakerIconOutline,
  Cog6ToothIcon as Cog6ToothIconOutline
} from '@heroicons/vue/24/outline'
import { DocumentDuplicateIcon, BeakerIcon, Cog6ToothIcon } from '@heroicons/vue/20/solid'
import FileTree from '../FileTree.vue'
import ProjectsManager from '../ProjectsManager.vue'
import EditorSettingsForm from '../EditorSettingsForm.vue'

const tabs = [
  { label: 'Files', icon: DocumentDuplicateIconOutline, iconActive: DocumentDuplicateIcon },
  { label: 'Projects', icon: BeakerIconOutline, iconActive: BeakerIcon },
  { label: 'IDE settings', icon: Cog6ToothIconOutline, iconActive: Cog6ToothIcon },
]
</script>

<template>
  <TabGroup as="div" class="flex h-full min-h-0 flex-col bg-surface">
    <TabList class="flex mx-2 gap-4 flex-shrink-0 border-b border-line">
      <Tab v-for="t in tabs" :key="t.label" v-slot="{ selected }" as="template">
        <button
          class="flex border-b-2 py-2 outline-none transition-colors"
          :class="selected ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-muted'"
          :title="t.label"
          :aria-label="t.label"
        >
          <component :is="selected ? t.iconActive : t.icon" class="size-6" />
        </button>
      </Tab>
    </TabList>
    <TabPanels class="flex min-h-0 flex-1 flex-col">
      <!-- Keep the tree mounted so switching tabs doesn't re-fetch the listing. -->
      <TabPanel :unmount="false" class="flex min-h-0 flex-1 flex-col outline-none">
        <FileTree />
      </TabPanel>
      <TabPanel class="flex min-h-0 flex-1 flex-col outline-none">
        <ProjectsManager />
      </TabPanel>
      <TabPanel class="flex min-h-0 flex-1 flex-col outline-none">
        <EditorSettingsForm />
      </TabPanel>
    </TabPanels>
  </TabGroup>
</template>
