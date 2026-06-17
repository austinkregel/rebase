<script setup lang="ts">
import { computed } from 'vue'
import { statusItems, type StatusItem } from '@/services/statusBar'
import { runCommand } from '@/services/commands'
import IconButton from './ui/IconButton.vue'

// Renders the plugin-contributed status items for one side of the StatusTray.
const props = defineProps<{ side: 'left' | 'right' }>()
const items = computed(() => statusItems(props.side))

function activate(item: StatusItem) {
  if (item.onClick) item.onClick()
  else if (item.command) void runCommand(item.command)
}
const toneClass = (t?: string) =>
  ({ accent: 'text-accent', warn: 'text-yellow', danger: 'text-red' })[t ?? ''] ?? ''
</script>

<template>
  <template v-for="item in items" :key="item.id">
    <component :is="item.component" v-if="item.component" />
    <IconButton
      v-else-if="item.icon && !item.text"
      :icon="item.icon"
      variant="plain"
      size="lg"
      :label="item.tooltip ?? item.id"
      :class="toneClass(item.tone)"
      @click="activate(item)"
    />
    <button
      v-else
      class="flex items-center gap-1 hover:text-fg"
      :class="toneClass(item.tone)"
      :title="item.tooltip"
      @click="activate(item)"
    >
      <component :is="item.icon" v-if="item.icon" class="size-4" />
      <span v-if="item.text">{{ item.text() }}</span>
    </button>
  </template>
</template>
