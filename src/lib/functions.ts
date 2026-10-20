import { supabase } from './supabase'

/** Calls a Supabase Edge Function as the signed-in user and surfaces the function's own error message. */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> })
  if (error) {
    let message = error.message
    try { const j = await (error as unknown as { context?: Response }).context?.json(); if (j?.error) message = String(j.error) } catch { /* keep the generic message */ }
    throw new Error(message)
  }
  return data as T
}
