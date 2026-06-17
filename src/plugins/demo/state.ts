import { ref } from 'vue'

export const counter = ref(0)
export const clockTime = ref(new Date().toLocaleTimeString())
export const eventLog = ref<string[]>([])

export function logEvent(msg: string) {
  eventLog.value.unshift(`${clockTime.value}  ${msg}`)
  if (eventLog.value.length > 30) eventLog.value.pop()
}
