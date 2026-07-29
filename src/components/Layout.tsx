import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import { APP_NAME } from '../lib/constants'

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <div className="hidden w-56 shrink-0 md:block">
        <Sidebar />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-56">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-pink-100 bg-white px-4 py-2.5 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md border border-pink-200 bg-pink-50 px-3 py-1.5 text-sm font-medium text-pink-800 hover:bg-pink-100"
          >
            ☰ Menu
          </button>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="Logo" className="h-7 w-auto object-contain" />
            <p className="font-bold text-gray-900 text-sm">{APP_NAME}</p>
          </div>
        </div>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
