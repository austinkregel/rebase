<script setup lang="ts">
import { computed } from 'vue'
// import { SomeIcon } from '@heroicons/vue/20/solid'
import IconButton from '@/components/ui/IconButton.vue'
import { runCommand } from '@/services/commands'

// Custom status-bar component for a plugin.
// - No props: the plugin host mounts this with `component: markRaw(TemplateStatus)`.
//   Read what you need from stores or reactive service functions directly.
// - Wrap everything in a <span class="flex items-center gap-1"> so it sits
//   inline with other status items in the tray.
// - Use IconButton size="lg" for any clickable icons (matches the status-bar
//   icon size convention — see IconButton.vue and NotificationsStatus.vue).

const label = computed(() => 'My Plugin')
</script>

<template>
  <span class="flex items-center gap-1">
    <!-- <SomeIcon class="size-5 text-subtle" /> -->
    <span>{{ label }}</span>
    <IconButton
      variant="plain"
      size="lg"
      label="My action"
      @click="runCommand('your-plugin-id.openPanel')"
    />
  </span>
</template>
