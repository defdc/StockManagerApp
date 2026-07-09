import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDateTime } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import type { ActivityLog, Profile } from '../types/database'

export default function Activity() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadActivity() {
      setLoading(true)
      setError(null)
      const [logsRes, profilesRes] = await Promise.all([
        supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('profiles').select('*'),
      ])

      if (logsRes.error) setError(logsRes.error.message)
      else {
        setLogs((logsRes.data as ActivityLog[]) ?? [])
        setProfiles((profilesRes.data as Profile[]) ?? [])
      }
      setLoading(false)
    }

    loadActivity()
  }, [])

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])

  const filteredLogs = useMemo(() => {
    return logs
      .map((log) => ({
        log,
        rank: smartSearchRank(search, [
          { value: log.action },
          { value: log.entity },
          { value: profileById.get(log.created_by ?? '')?.full_name },
          { value: JSON.stringify(log.details), kind: 'notes' },
        ]),
      }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.log.created_at.localeCompare(a.log.created_at))
      .map((entry) => entry.log)
  }, [logs, profileById, search])

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Activity</h1>

      <input
        type="text"
        placeholder="Search action, entity, user, or details..."
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading activity...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Time</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Action</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Entity</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">User</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-gray-400">
                    No activity found.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => {
                  const profile = profileById.get(log.created_by ?? '')
                  return (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2">{formatDateTime(log.created_at)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{log.action}</td>
                      <td className="whitespace-nowrap px-3 py-2">{log.entity}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {profile?.full_name || log.created_by?.slice(0, 8) || '-'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
