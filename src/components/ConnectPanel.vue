<script setup lang="ts">
import { ServerStackIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
</script>

<template>
  <div class="w-full max-w-md rounded-xl border border-line bg-surface p-7">
    <h1 class="mb-3 text-xl font-semibold tracking-[0.08em] text-fg">rebase</h1>
    <p class="mb-4 text-[12.5px] leading-relaxed text-muted">Connect to your control plane.</p>

    <ul class="mb-3 flex flex-col gap-1.5">
      <li v-for="cp in session.controlPlanes" :key="cp.name">
        <button
          class="flex w-full items-center gap-2.5 rounded-md border border-line bg-elevated px-3 py-2.5 text-left hover:border-accent"
          @click="session.connect(cp)"
        >
          <ServerStackIcon class="size-4 shrink-0 text-subtle" />
          <span class="flex flex-col overflow-hidden">
            <span class="text-[13px] text-fg">{{ cp.name }}</span>
            <span class="overflow-hidden text-ellipsis text-[11px] text-subtle">{{ cp.url }}</span>
          </span>
        </button>
      </li>
      <li v-if="!session.controlPlanes.length" class="text-[12px] text-subtle">
        No control plane configured. Add one to <code class="text-fg">config.toml</code>.
      </li>
    </ul>

    <div class="flex justify-end">
      <button class="text-[12px] text-subtle hover:text-accent" @click="session.logout()">Sign out</button>
    </div>

    <p v-if="session.error" class="mt-3.5 text-[12px] text-red">{{ session.error }}</p>
  </div>
</template>
