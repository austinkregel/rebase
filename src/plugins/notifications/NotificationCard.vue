<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/vue/20/solid'
import IconButton from '@/components/ui/IconButton.vue'
import Button from '@/components/ui/Button.vue'
import { formatTimeAgo, type AppNotification, type NotificationAction } from '@/services/notifications'

// Shared notification card — used both as a transient toast and as a row in the
// notification center. `toast` clamps the body (the center shows it in full),
// with a "show more" toggle for long messages.
const props = defineProps<{ notification: AppNotification; toast?: boolean }>()
const emit = defineEmits<{ (e: 'dismiss'): void }>()

const expanded = ref(false)
// Offer the toggle only when the clamped body would likely hide content.
const expandable = computed(() => {
  const body = props.notification.body
  if (!props.toast || !body) return false
  return body.length > 160 || (body.match(/\n/g)?.length ?? 0) >= 5
})

const ICONS = {
  info: InformationCircleIcon,
  success: CheckCircleIcon,
  warning: ExclamationTriangleIcon,
  error: ExclamationCircleIcon,
} as const

const TONES = {
  info: 'text-accent',
  success: 'text-green',
  warning: 'text-yellow',
  error: 'text-red',
} as const

const icon = computed(() => ICONS[props.notification.level])
const tone = computed(() => TONES[props.notification.level])
const when = computed(() => formatTimeAgo(props.notification.createdAt))

async function runAction(action: NotificationAction) {
  try {
    await action.run()
  } finally {
    if (action.dismiss !== false) emit('dismiss')
  }
}
</script>

<template>
  <div class="group/card relative flex gap-2.5 rounded-lg border border-line bg-elevated p-2.5 pr-7">
    <component :is="icon" class="mt-px size-4 shrink-0" :class="tone" />

    <div class="min-w-0 flex-1">
      <div class="flex items-start gap-2">
        <p class="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-fg line-clamp-2">
          {{ notification.title }}
        </p>
        <span class="shrink-0 pt-px text-2xs tabular-nums text-subtle">{{ when }}</span>
      </div>

      <p
        v-if="notification.body"
        class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted"
        :class="toast && !expanded && 'line-clamp-6'"
      >
        {{ notification.body }}
      </p>
      <button
        v-if="expandable"
        class="mt-0.5 text-2xs font-medium text-accent hover:underline"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>

      <div v-if="notification.source || notification.actions?.length" class="mt-1.5 flex items-center gap-2">
        <span v-if="notification.source" class="text-2xs uppercase tracking-wide text-subtle">
          {{ notification.source }}
        </span>
        <span v-if="notification.actions?.length" class="ml-auto flex gap-1.5">
          <Button
            v-for="(a, i) in notification.actions"
            :key="i"
            variant="ghost"
            class="!px-1.5 !py-0.5 text-accent hover:text-accent"
            @click="runAction(a)"
          >
            {{ a.label }}
          </Button>
        </span>
      </div>
    </div>

    <IconButton
      :icon="XMarkIcon"
      label="dismiss"
      variant="plain"
      class="absolute right-1.5 top-1.5 text-subtle opacity-0 transition-opacity hover:text-fg group-hover/card:opacity-100"
      @click="emit('dismiss')"
    />
  </div>
</template>
