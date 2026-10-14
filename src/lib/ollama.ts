import type { Message, OllamaModel } from '../types'

export async function pingOllama(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, '')
  const response = await fetch(`${normalized}/api/tags`, {
    method: 'GET',
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Ollama is unavailable at ${normalized}.`)
  }

  const payload = (await response.json()) as { models?: OllamaModel[] }
  return (payload.models ?? []).map((model) => model.name)
}

export async function sendOllamaChat(
  baseUrl: string,
  model: string,
  messages: Message[],
  options?: { temperature?: number; num_ctx?: number; format?: 'json' | Record<string, unknown> },
) {
  const normalized = baseUrl.replace(/\/$/, '')
  const response = await fetch(`${normalized}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: messages.map(({ role, content }) => ({ role, content })),
      options: {
        temperature: options?.temperature ?? 0.2,
        num_ctx: options?.num_ctx ?? 8192,
      },
      ...(options?.format ? { format: options.format } : {}),
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'Unable to get a response from Ollama.')
  }

  const payload = (await response.json()) as {
    message?: { content?: string }
    content?: string
    response?: string
  }

  return payload.message?.content ?? payload.content ?? payload.response ?? ''
}
