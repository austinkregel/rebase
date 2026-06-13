<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { contextMenu, closeContextMenu, type ContextMenuItem } from '@/services/contextMenu'

// Renders the shared floating menu at the pointer. Mount one instance high in
// the panel; it positions itself, clamps to the viewport, and dismisses on
// outside-click, Esc, scroll, or resize.
const panel = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

const items = computed(() => contextMenu.items)

function choose(item: ContextMenuItem) {
  if (item.disabled) return
  closeContextMenu()
  item.action?.()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('scroll', closeContextMenu, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('scroll', closeContextMenu, true)
})

// Clamp the menu inside the viewport once it's rendered and measurable.
watch(
  () => contextMenu.open,
  async (open) => {
    if (!open) return
    pos.value = { x: contextMenu.x, y: contextMenu.y }
    await nextTick()
    const el = panel.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 6
    let { x, y } = pos.value
    if (x + rect.width + margin > window.innerWidth) x = window.innerWidth - rect.width - margin
    if (y + rect.height + margin > window.innerHeight) y = window.innerHeight - rect.height - margin
    pos.value = { x: Math.max(margin, x), y: Math.max(margin, y) }
  },
)
</script>

<template>
  <teleport to="body">
    <div v-if="contextMenu.open" class="fixed inset-0 z-[1000]" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu">
      <div
        ref="panel"
        class="fixed min-w-[176px] rounded-md border border-line bg-elevated py-1 text-[12.5px] shadow-xl"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @click.stop
      >
        <template v-for="(item, i) in items" :key="i">
          <div v-if="item.separator && i > 0" class="my-1 border-t border-line" />
          <button
            class="flex w-full items-center px-3 py-1 text-left disabled:opacity-40"
            :class="item.danger ? 'text-red hover:bg-red/15' : 'text-muted hover:bg-hover hover:text-fg'"
            :disabled="item.disabled"
            @click="choose(item)"
          >
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </teleport>
</template>
