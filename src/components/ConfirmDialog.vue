<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue'
import { confirmState, resolveConfirm } from '@/services/confirm'
import Button from '@/components/ui/Button.vue'
</script>

<template>
  <Dialog :open="confirmState.open" class="relative z-[1100]" @close="resolveConfirm(false)">
    <div class="fixed inset-0 bg-black/40" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel class="w-full max-w-sm rounded-lg border border-line bg-elevated p-4 shadow-2xl">
        <DialogTitle class="text-base font-medium text-fg">{{ confirmState.title }}</DialogTitle>
        <p class="mt-2 whitespace-pre-wrap text-sm text-muted">{{ confirmState.message }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="secondary" @click="resolveConfirm(false)">Cancel</Button>
          <Button :variant="confirmState.danger ? 'danger' : 'primary'" @click="resolveConfirm(true)">
            {{ confirmState.confirmLabel }}
          </Button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
