<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue'
import { confirmState, resolveConfirm } from '@/services/confirm'
</script>

<template>
  <Dialog :open="confirmState.open" class="relative z-[1100]" @close="resolveConfirm(false)">
    <div class="fixed inset-0 bg-black/40" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel class="w-full max-w-sm rounded-lg border border-line bg-elevated p-4 shadow-2xl">
        <DialogTitle class="text-[13px] font-medium text-fg">{{ confirmState.title }}</DialogTitle>
        <p class="mt-2 whitespace-pre-wrap text-[12px] text-muted">{{ confirmState.message }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            class="rounded border border-line px-3 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            @click="resolveConfirm(false)"
          >
            Cancel
          </button>
          <button
            class="rounded px-3 py-1 text-[12px] text-bg"
            :class="confirmState.danger ? 'bg-red hover:opacity-90' : 'bg-accent hover:opacity-90'"
            @click="resolveConfirm(true)"
          >
            {{ confirmState.confirmLabel }}
          </button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
