import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { APP_NAME } from '../lib/constants'

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/bookings', label: 'Bookings' },
  { to: '/sales', label: 'Sales' },
  { to: '/reports', label: 'Reports' },
  { to: '/buyers', label: 'Buyers' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/batches', label: 'Batches' },
  { to: '/import', label: 'Import Excel' },
  { to: '/activity', label: 'Activity' },
]

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, role } = useAuth()

  return (
    <div className="flex h-full flex-col bg-white border-r border-pink-100 text-gray-800 shadow-sm">
      <div className="border-b border-pink-100 px-4 py-3.5 bg-pink-50/40 flex flex-col items-start">
        <img
          src="/logo.png"
          alt="PINKIEPIE GARAGE Logo"
          className="h-10 w-auto object-contain mb-1 drop-shadow-sm"
        />
        <p className="text-base font-bold text-gray-900 tracking-tight">{APP_NAME}</p>
        <div className="flex items-center gap-1.5 mt-0.5 max-w-full">
          <p className="truncate text-xs text-gray-500 font-medium">{user?.email}</p>
          <span className="shrink-0 rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-pink-800">
            {role}
          </span>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-pink-100 text-pink-900 font-semibold border-l-4 border-pink-600'
                  : 'text-gray-600 hover:bg-pink-50 hover:text-pink-800'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-pink-100 p-2">
        <button
          onClick={() => supabase.auth.signOut()}
          className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-gray-600 hover:bg-pink-50 hover:text-pink-800 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
