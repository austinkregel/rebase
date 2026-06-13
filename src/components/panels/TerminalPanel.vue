<script setup lang="ts">
import Terminal from '../Terminal.vue'

// dockview passes a `params` prop to every panel component; declare it so it
// isn't applied as a stray DOM attribute. This panel ignores it.
defineProps<{ params?: unknown }>()
</script>

<template>
  <Terminal />
</template>
