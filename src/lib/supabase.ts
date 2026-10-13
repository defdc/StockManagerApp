import { createClient } from '@supabase/supabase-js'
import { trackedFetch } from './dataSync'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.'
  )
}

// `trackedFetch` turns every successful REST mutation into a global data invalidation
// (see src/lib/dataSync.ts), so derived views like Batches never show stale numbers.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: trackedFetch },
})
