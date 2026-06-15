<script setup lang="ts">
import { computed } from 'vue'
import { TabGroup, TabList, Tab, TabPanels, TabPanel } from '@headlessui/vue'
import { viewsFor } from '@/services/views'

// Plugin-contributed tools views (Crucible chat, Terminals, …) as tabs, so each
// gets the full column height. Crucible (order 1) is the default tab.
const tabs = computed(() => viewsFor('sidebar.tools'))
</script>

<template>
  <TabGroup v-if="tabs.length" as="div" class="flex h-full min-h-0 flex-col bg-surface">
    <TabList class="mx-2 flex flex-shrink-0 gap-4 border-b border-line">
      <Tab v-for="t in tabs" :key="t.id" v-slot="{ selected }" as="template">
        <button
          class="flex border-b-2 py-2 outline-none transition-colors"
          :class="selected ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-muted'"
          :title="t.title"
          :aria-label="t.title"
        >
          <component :is="selected ? (t.iconActive ?? t.icon) : t.icon" class="size-6" />
        </button>
      </Tab>
    </TabList>
    <TabPanels class="flex min-h-0 flex-1 flex-col">
      <TabPanel v-for="t in tabs" :key="t.id" class="flex min-h-0 flex-1 flex-col outline-none">
        <component :is="t.component" />
      </TabPanel>
    </TabPanels>
  </TabGroup>
</template>
