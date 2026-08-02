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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<UserRole>('viewer')
  const [loading, setLoading] = useState(true)

  async function fetchUserRole(userId: string) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single()
      if (!error && data?.role && ['admin', 'editor', 'viewer'].includes(data.role)) {
        setRole(data.role as UserRole)
      } else {
        setRole('viewer')
      }
    } catch {
      setRole('viewer')
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      if (data.session?.user) {
        await fetchUserRole(data.session.user.id)
      } else {
        setRole('viewer')
      }
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession)
      if (newSession?.user) {
        await fetchUserRole(newSession.user.id)
      } else {
        setRole('viewer')
      }
      setLoading(false)
    })

    return () => listener.subscription.unsubscribe()
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
