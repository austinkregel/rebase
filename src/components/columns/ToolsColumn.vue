<script setup lang="ts">
import { computed } from 'vue'
import { viewsFor } from '@/services/views'
import CodeSearch from '../CodeSearch.vue'

// Core tool (Code Search) plus any plugin-contributed tools views.
const toolViews = computed(() => viewsFor('sidebar.tools'))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <CodeSearch />
    <component :is="v.component" v-for="v in toolViews" :key="v.id" />
  </div>
</template>
