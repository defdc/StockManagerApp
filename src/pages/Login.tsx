import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { APP_NAME } from '../lib/constants'

export default function Login() {
  const { session, loading: authLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!authLoading && session) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setSubmitting(false)
    if (error) setError(error.message)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-pink-50/30 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-md border border-pink-100 text-center flex flex-col items-center">
        <img src="/logo.png" alt="PINKIEPIE GARAGE Logo" className="h-14 w-auto object-contain mb-2 drop-shadow-sm" />
        <h1 className="mb-1 text-xl font-bold text-gray-900 tracking-tight">{APP_NAME}</h1>
        <p className="mb-6 text-sm text-gray-500">Internal use only. Sign in to continue.</p>

        <form onSubmit={handleSubmit} className="w-full space-y-4 text-left">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-xs text-gray-400">
          Accounts are created by an admin in the Supabase dashboard. Contact your partner if you
          don't have credentials.
        </p>
      </div>
    </div>
  )
}
