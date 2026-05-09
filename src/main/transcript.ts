const MAX_CHARS = 2000
const STORE_CHARS = Math.max(MAX_CHARS * 2, 4000)

let buffer = ''

export function append(text: string): void {
  if (!text) return
  buffer = buffer ? `${buffer} ${text}` : text
  if (buffer.length > STORE_CHARS) {
    buffer = buffer.slice(buffer.length - STORE_CHARS)
  }
}

export function recent(): string {
  return buffer.length > MAX_CHARS ? buffer.slice(buffer.length - MAX_CHARS) : buffer
}

export function clear(): void {
  buffer = ''
}
