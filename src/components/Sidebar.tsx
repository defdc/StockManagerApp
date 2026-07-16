import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/bookings', label: 'Bookings' },
  { to: '/sales', label: 'Sales' },
  { to: '/buyers', label: 'Buyers' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/batches', label: 'Batches' },
  { to: '/import', label: 'Import Excel' },
  { to: '/activity', label: 'Activity' },
]

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()

  return (
    <div className="flex h-full flex-col bg-gray-900 text-gray-100">
      <div className="border-b border-gray-800 px-4 py-4">
        <p className="text-lg font-semibold">Stock Manager</p>
        <p className="truncate text-xs text-gray-400">{user?.email}</p>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `block rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-gray-800 p-2">
        <button
          onClick={() => supabase.auth.signOut()}
          className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
