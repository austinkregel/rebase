<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import Workbench from './Workbench.vue'
import Onboarding from './Onboarding.vue'
import ConnectPanel from './ConnectPanel.vue'
import Button from './ui/Button.vue'

const session = useSessionStore()
</script>

<template>
  <Workbench v-if="session.phase === 'connected'" />
  <div v-else class="flex h-dvh items-center justify-center p-6">
    <Onboarding v-if="session.phase === 'unauthenticated'" />
    <ConnectPanel v-else-if="session.phase === 'disconnected'" />
    <div v-else class="w-full max-w-md rounded-xl border border-line bg-surface p-7 text-center">
      <p class="text-base text-muted">{{ session.phase === 'connecting' ? 'connecting…' : 'loading…' }}</p>
      <Button
        v-if="session.phase === 'connecting'"
        variant="ghost"
        class="mt-2"
        @click="session.disconnect()"
      >
        cancel
      </Button>
    </div>
  </div>
</template>
