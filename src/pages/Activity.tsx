import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatDateTime } from '../lib/format'
import type { ActivityLog, Profile } from '../types/database'

const PAGE_SIZE = 200
const SEARCH_DEBOUNCE_MS = 300

function getUserDisplay(
  userId: string | null,
  profile: Profile | undefined,
  currentUserEmail?: string,
  currentUserId?: string
): string {
  if (!userId) return 'Unknown user'
  if (profile?.email) return profile.email
  if (profile?.full_name) return profile.full_name
  if (userId === currentUserId && currentUserEmail) return currentUserEmail
  return userId.slice(0, 8) || 'Unknown user'
}

export function getActivityDescription(log: ActivityLog): string {
  // 1. Explicit description property
  if (log.description && typeof log.description === 'string' && log.description.trim()) {
    return log.description.trim()
  }

  // 2. Nested description inside details JSON
  if (typeof log.details?.description === 'string' && log.details.description.trim()) {
    return log.details.description.trim()
  }

  // 3. If entity column already contains a detailed description (not just a generic table name)
  const genericEntities = new Set([
    'inventory_items',
    'sales',
    'bookings',
    'legacy_imports',
    'expenses',
    'batches',
    'partners',
  ])
  const entityTrimmed = (log.entity || '').trim()
  if (entityTrimmed && !genericEntities.has(entityTrimmed.toLowerCase())) {
    return entityTrimmed
  }

  // 4. Synthesize human-readable description for legacy logs
  const details = log.details ?? {}
  const actionLower = (log.action || '').toLowerCase()

  if (actionLower.includes('bulk delete') || (actionLower.includes('delete') && details.count)) {
    return `Bulk deleted ${details.count ?? ''} items from ${entityTrimmed || 'Inventory'}`.trim()
  }

  if (
    actionLower.includes('bulk booking') ||
    (actionLower.includes('booking') && details.count && Number(details.count) > 1)
  ) {
    const buyer = details.buyer_name ? ` for buyer ${details.buyer_name}` : ''
    return `Created bulk booking for ${details.count} items${buyer}`
  }

  if (
    actionLower.includes('bulk sale') ||
    actionLower.includes('convert to sale') ||
    (actionLower.includes('sale') && details.count && Number(details.count) > 1)
  ) {
    const buyer = details.buyer_name ? ` for buyer ${details.buyer_name}` : ''
    return `Converted ${details.count} items to sale${buyer}`
  }

  if (actionLower.includes('bulk add')) {
    const batch = details.batch_name ? ` to batch ${details.batch_name}` : ''
    return `Bulk added ${details.count ?? ''} items${batch}`.trim()
  }

  if (actionLower.includes('revert import')) {
    const fileName = details.file_name ? ` "${details.file_name}"` : ''
    const count = details.deleted_items ? ` (deleted ${details.deleted_items} items)` : ''
    return `Reverted import${fileName}${count}`
  }

  if (actionLower.includes('import')) {
    const count = details.clean_rows || details.count || details.total_rows || ''
    const file = details.file_name ? ` from Excel (${details.file_name})` : ' from Excel'
    return `Imported ${count} items${file}`.trim()
  }

  if (actionLower.includes('delete')) {
    if (details.item_name) {
      const batch = details.batch_name ? ` from batch ${details.batch_name}` : ''
      return `Deleted item: ${details.item_name}${batch}`
    }
    if (details.buyer_name) {
      return `Deleted ${log.entity === 'bookings' ? 'booking' : 'sale'} for buyer ${details.buyer_name}`
    }
    return `Deleted record from ${entityTrimmed || 'database'}`
  }

  if (actionLower.includes('undo sale')) {
    const buyer = details.buyer_name ? ` for buyer ${details.buyer_name}` : ''
    return `Undid sale${buyer}`
  }

  if (actionLower.includes('edit group sale') || actionLower.includes('edit bulk booking')) {
    const count = details.count ? ` of ${details.count} items` : ''
    const buyer = details.buyer_name ? ` for buyer ${details.buyer_name}` : ''
    return `Updated group transaction${count}${buyer}`
  }

  if (actionLower.includes('sale')) {
    const buyer = details.buyer_name ? ` to buyer ${details.buyer_name}` : ''
    return `Sale${buyer}`
  }

  if (actionLower.includes('booking')) {
    const buyer = details.buyer_name ? ` for buyer ${details.buyer_name}` : ''
    return `Booking${buyer}`
  }

  return entityTrimmed || '-'
}

export default function Activity() {
  const { user } = useAuth()
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const loadActivity = useCallback(async () => {
    setLoading(true)
    setError(null)
    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    const profilesRes = await supabase.from('profiles').select('id, full_name, email, role, created_at')
    const loadedProfiles = (profilesRes.data as Profile[]) ?? []
    setProfiles(loadedProfiles)

    let logsQuery = supabase
      .from('activity_logs')
      .select('id, action, entity, description, entity_id, details, created_by, created_at', { count: 'exact' })

    if (startDate) {
      logsQuery = logsQuery.gte('created_at', `${startDate}T00:00:00`)
    }
    if (endDate) {
      logsQuery = logsQuery.lte('created_at', `${endDate}T23:59:59.999`)
    }

    const trimmedSearch = debouncedSearch.trim()
    if (trimmedSearch) {
      const words = trimmedSearch.split(/\s+/).filter(Boolean)
      for (const word of words) {
        const safeWord = word.replace(/[,()]/g, '')
        if (!safeWord) continue
        const lowerWord = safeWord.toLowerCase()
        const matchingProfileIds = loadedProfiles
          .filter(
            (p) =>
              p.email?.toLowerCase().includes(lowerWord) ||
              p.full_name?.toLowerCase().includes(lowerWord)
          )
          .map((p) => p.id)

        if (matchingProfileIds.length > 0) {
          logsQuery = logsQuery.or(
            `action.ilike.%${safeWord}%,description.ilike.%${safeWord}%,entity.ilike.%${safeWord}%,created_by.in.(${matchingProfileIds.join(',')})`
          )
        } else {
          logsQuery = logsQuery.or(
            `action.ilike.%${safeWord}%,description.ilike.%${safeWord}%,entity.ilike.%${safeWord}%`
          )
        }
      }
    }

    const logsRes = await logsQuery.order('created_at', { ascending: false }).range(from, to)

    if (logsRes.error) {
      setError(logsRes.error.message)
    } else {
      const nextLogs = (logsRes.data as ActivityLog[]) ?? []
      setLogs(nextLogs)
      setTotalCount(logsRes.count ?? nextLogs.length)
    }
    setLoading(false)
  }, [page, startDate, endDate, debouncedSearch])

  useEffect(() => {
    void loadActivity()
  }, [loadActivity])

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])

  const filteredLogs = useMemo(() => {
    return logs.map((log) => {
      const profile = profileById.get(log.created_by ?? '')
      const userDisplay = getUserDisplay(log.created_by, profile, user?.email, user?.id)
      const description = getActivityDescription(log)

      return {
        log,
        userDisplay,
        description,
      }
    })
  }, [logs, profileById, user?.email, user?.id])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const hasPrevPage = page > 1
  const hasNextPage = page < totalPages
  const pageFrom = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageTo = totalCount === 0 ? 0 : Math.min(totalCount, page * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Activity</h1>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Search action, description, user, or details..."
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full sm:w-72 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <label htmlFor="activity-start-date" className="text-xs font-medium text-gray-500 whitespace-nowrap">
                Start Date
              </label>
              <input
                id="activity-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 focus:border-gray-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label htmlFor="activity-end-date" className="text-xs font-medium text-gray-500 whitespace-nowrap">
                End Date
              </label>
              <input
                id="activity-end-date"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 focus:border-gray-500 focus:outline-none"
              />
            </div>

            {(startDate || endDate) && (
              <button
                type="button"
                onClick={() => {
                  setStartDate('')
                  setEndDate('')
                  setPage(1)
                }}
                className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 focus:outline-none"
              >
                Clear dates
              </button>
            )}
          </div>
        </div>
      </div>

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
                <th className="px-3 py-2 text-left font-medium text-gray-600">Description</th>
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
                filteredLogs.map(({ log, userDisplay, description }) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{formatDateTime(log.created_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-900">{log.action}</td>
                    <td className="px-3 py-2 text-gray-700">{description}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{userDisplay}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Server-Side Pagination Controls */}
      {!loading && totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
          <div className="text-gray-600">
            Showing <span className="font-medium text-gray-900">{pageFrom}</span> to{' '}
            <span className="font-medium text-gray-900">{pageTo}</span> of{' '}
            <span className="font-medium text-gray-900">{totalCount}</span> activity logs (Page{' '}
            <span className="font-medium text-gray-900">{page}</span> of{' '}
            <span className="font-medium text-gray-900">{totalPages}</span>)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!hasPrevPage || loading}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous Page
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage || loading}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next Page
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
