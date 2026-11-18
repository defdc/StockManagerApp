import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { UserRole } from '../types/database'

interface AuthContextValue {
  session: Session | null
  user: User | null
  role: UserRole
  canWrite: boolean
  isViewer: boolean
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  role: 'viewer',
  canWrite: false,
  isViewer: true,
  loading: true,
})

// Module-level role cache & in-flight deduplication to prevent duplicate `profiles` queries
// across simultaneous `getSession()` + `onAuthStateChange()` calls and Vite HMR reloads.
const cachedRoleByUserId = new Map<string, UserRole>()
const inFlightRoleFetch = new Map<string, Promise<UserRole>>()

async function resolveUserRole(userId: string): Promise<UserRole> {
  const cached = cachedRoleByUserId.get(userId)
  if (cached) return cached

  const existingPromise = inFlightRoleFetch.get(userId)
  if (existingPromise) return existingPromise

  const fetchPromise = (async (): Promise<UserRole> => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single()
      if (!error && data?.role && ['admin', 'editor', 'viewer'].includes(data.role)) {
        const resolved = data.role as UserRole
        cachedRoleByUserId.set(userId, resolved)
        return resolved
      }
      return 'viewer'
    } catch {
      return 'viewer'
    } finally {
      inFlightRoleFetch.delete(userId)
    }
  })()

  inFlightRoleFetch.set(userId, fetchPromise)
  return fetchPromise
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<UserRole>('viewer')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      setSession(data.session)
      if (data.session?.user) {
        const resolvedRole = await resolveUserRole(data.session.user.id)
        if (mounted) setRole(resolvedRole)
      } else {
        setRole('viewer')
      }
      if (mounted) setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      if (event === 'SIGNED_OUT') {
        cachedRoleByUserId.clear()
      }
      setSession(newSession)
      if (newSession?.user) {
        const resolvedRole = await resolveUserRole(newSession.user.id)
        if (mounted) setRole(resolvedRole)
      } else {
        setRole('viewer')
      }
      if (mounted) setLoading(false)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const canWrite = role === 'admin' || role === 'editor'
  const isViewer = !canWrite

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, role, canWrite, isViewer, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
