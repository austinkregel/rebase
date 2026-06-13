<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRightEndOnRectangleIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'
import Button from '@/components/ui/Button.vue'

const session = useSessionStore()
const showFallback = ref(false)
const mode = ref<'client' | 'token'>('client')
const token = ref('')
const clientId = ref('')
const clientSecret = ref('')
const busy = ref(false)

async function submitFallback() {
  busy.value = true
  if (mode.value === 'token') {
    await session.setCredentials({ token: token.value.trim() })
  } else {
    await session.setCredentials({
      clientId: clientId.value.trim(),
      clientSecret: clientSecret.value.trim(),
    })
  }
  busy.value = false
}

const field =
  'w-full rounded-md border border-line bg-elevated px-2.5 py-2 text-sm text-fg outline-none focus:border-accent'
</script>

<template>
  <div class="w-full max-w-md rounded-xl border border-line bg-surface p-7">
    <h1 class="mb-3 text-xl font-semibold tracking-[0.08em] text-fg">rebase</h1>
    <p class="mb-4 text-sm leading-relaxed text-muted">
      Sign in to your control plane to connect to your machines.
    </p>

    <Button variant="primary" size="md" block @click="session.login()">
      <ArrowRightEndOnRectangleIcon class="size-4" /> Sign in with browser
    </Button>

    <template v-if="session.supportsCredentials">
      <Button variant="ghost" class="mt-3" @click="showFallback = !showFallback">
        {{ showFallback ? 'Hide' : 'Use a token instead' }}
      </Button>

      <form v-if="showFallback" class="mt-2 flex flex-col gap-2" @submit.prevent="submitFallback">
        <div class="flex gap-1">
          <button
            type="button"
            class="flex-1 rounded-md border px-2 py-1.5 text-sm"
            :class="mode === 'client' ? 'border-accent text-fg' : 'border-line text-muted'"
            @click="mode = 'client'"
          >
            Client credentials
          </button>
          <button
            type="button"
            class="flex-1 rounded-md border px-2 py-1.5 text-sm"
            :class="mode === 'token' ? 'border-accent text-fg' : 'border-line text-muted'"
            @click="mode = 'token'"
          >
            Machine token
          </button>
        </div>
        <template v-if="mode === 'client'">
          <input v-model="clientId" :class="field" placeholder="client_id" spellcheck="false" autocomplete="off" />
          <input v-model="clientSecret" type="password" :class="field" placeholder="client_secret" autocomplete="off" />
        </template>
        <textarea v-else v-model="token" rows="3" :class="field" placeholder="paste machine token (JWT)" spellcheck="false" />
        <Button variant="primary" size="md" block type="submit" :disabled="busy">
          {{ busy ? 'saving…' : 'Save & continue' }}
        </Button>
      </form>
    </template>

    <p v-if="session.error" class="mt-3.5 text-sm text-red">{{ session.error }}</p>
  </div>
</template>
